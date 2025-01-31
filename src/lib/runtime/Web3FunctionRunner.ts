import { isAddress } from "@ethersproject/address";
import { randomUUID } from "crypto";
import { performance } from "perf_hooks";
import onExit from "signal-exit";
import { Web3FunctionHttpClient } from "../net/Web3FunctionHttpClient";
import { Web3FunctionHttpProxy } from "../net/Web3FunctionHttpProxy";
import { Web3FunctionNetHelper } from "../net/Web3FunctionNetHelper";
import { MultiChainProviderConfig } from "../provider";
import { Web3FunctionProxyProvider } from "../provider/Web3FunctionProxyProvider";
import {
  Web3FunctionResult,
  Web3FunctionResultV1,
  Web3FunctionResultV2,
  Web3FunctionUserArgs,
  Web3FunctionUserArgsSchema,
  Web3FunctionVersion,
} from "../types";
import { Web3FunctionContextData } from "../types/Web3FunctionContext";
import {
  Web3FunctionEvent,
  Web3FunctionStorage,
  Web3FunctionStorageWithSize,
} from "../types/Web3FunctionEvent";
import { Web3FunctionAbstractSandbox } from "./sandbox/Web3FunctionAbstractSandbox";
import { Web3FunctionDockerSandbox } from "./sandbox/Web3FunctionDockerSandbox";
import { Web3FunctionThreadSandbox } from "./sandbox/Web3FunctionThreadSandbox";
import {
  Web3FunctionExec,
  Web3FunctionRunnerOptions,
  Web3FunctionRunnerPayload,
  Web3FunctionRuntimeError,
  Web3FunctionThrottled,
} from "./types";

const START_TIMEOUT = 5_000;
const delay = (t: number) => new Promise((resolve) => setTimeout(resolve, t));

export class Web3FunctionRunner {
  private _debug: boolean;
  private _memory = 0;
  private _proxyProvider?: Web3FunctionProxyProvider;
  private _httpProxy?: Web3FunctionHttpProxy;
  private _client?: Web3FunctionHttpClient;
  private _sandbox?: Web3FunctionAbstractSandbox;
  private _execTimeoutId?: NodeJS.Timeout;
  private _memoryIntervalId?: NodeJS.Timer;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private _exitRemover: () => void = () => {};

  constructor(debug = false) {
    this._debug = debug;
  }

  public validateUserArgs(
    userArgsSchema: Web3FunctionUserArgsSchema,
    userArgs: Web3FunctionUserArgs
  ) {
    for (const key in userArgsSchema) {
      const value = userArgs[key];
      if (typeof value === "undefined") {
        throw new Error(`Web3FunctionSchemaError: Missing user arg '${key}'`);
      }
      const type = userArgsSchema[key];
      switch (type) {
        case "boolean":
        case "string":
        case "number":
          if (typeof value !== type) {
            throw new Error(
              `Web3FunctionSchemaError: Invalid ${type} value '${value.toString()}' for user arg '${key}'`
            );
          }
          break;
        case "boolean[]":
        case "string[]":
        case "number[]": {
          const itemType = type.slice(0, -2);
          if (
            !Array.isArray(value) ||
            value.some((a) => typeof a !== itemType)
          ) {
            throw new Error(
              `Web3FunctionSchemaError: Invalid ${type} value '${value}' for user arg '${key}'`
            );
          }
          break;
        }
        default:
          throw new Error(
            `Web3FunctionSchemaError: Unrecognized type '${type}' for user arg '${key}'`
          );
      }
    }
  }

  private _getInvalidParseExample(type: string): string {
    const useStr = (value: string) => `(use: '${value}')`;

    switch (type) {
      case "boolean":
        return useStr("true");
      case "boolean[]":
        return useStr("[true, false]");
      case "string":
        return useStr('"a"');
      case "string[]":
        return useStr('["a", "b"]');
      case "number":
        return useStr("1");
      case "number[]":
        return useStr("[1, 2]");
      default:
        return "";
    }
  }

  public parseUserArgs(
    userArgsSchema: Web3FunctionUserArgsSchema,
    inputUserArgs: { [key: string]: string }
  ): Web3FunctionUserArgs {
    const typedUserArgs: Web3FunctionUserArgs = {};
    for (const key in userArgsSchema) {
      const value = inputUserArgs[key];
      if (typeof value === "undefined") {
        throw new Error(`Web3FunctionSchemaError: Missing user arg '${key}'`);
      }

      const type = userArgsSchema[key];
      const typing = type.split("[]");
      const baseType = typing[0];

      try {
        const parsedValue = JSON.parse(value);
        if (
          (typing.length > 1 &&
            (!Array.isArray(parsedValue) ||
              parsedValue.some((a) => typeof a !== baseType))) ||
          (typing.length === 1 && typeof parsedValue !== baseType)
        ) {
          // array type
          throw new Error(
            `Web3FunctionSchemaError: Invalid ${type} value '${value}' for user arg '${key}' ${this._getInvalidParseExample(
              type
            )}`
          );
        }

        typedUserArgs[key] = parsedValue;
      } catch (err) {
        throw new Error(`Parsing ${value} to ${type} failed. \n${err.message}`);
      }
    }
    return typedUserArgs;
  }

  public async run(
    payload: Web3FunctionRunnerPayload
  ): Promise<Web3FunctionExec> {
    const start = performance.now();
    const throttled: Web3FunctionThrottled = {};
    let success: boolean;
    let result: Web3FunctionResult | undefined = undefined;
    let storage: Web3FunctionStorageWithSize | undefined = undefined;
    let error: Error | undefined = undefined;
    const { script, context, options, version, multiChainProviderConfig } =
      payload;
    try {
      const data = await this._runInSandbox(
        script,
        version,
        context,
        options,
        multiChainProviderConfig
      );
      this._validateResult(version, data.result);

      result = data.result;
      storage = {
        ...data.storage,
        size: Buffer.byteLength(JSON.stringify(data.storage), "utf-8") / 1024,
      };
      success = true;
    } catch (err) {
      error = err;
      success = false;
    } finally {
      await this.stop();
    }

    const logs: string[] = this._sandbox?.getLogs() ?? [];
    const duration = (performance.now() - start) / 1000;
    const memory = this._memory / 1024 / 1024;
    const rpcCalls = this._proxyProvider?.getNbRpcCalls() ?? {
      total: 0,
      throttled: 0,
    };
    const networkStats = this._httpProxy?.getStats() ?? {
      nbRequests: 0,
      nbThrottled: 0,
      download: 0,
      upload: 0,
    };

    this._log(`Runtime duration=${duration.toFixed(2)}s`);
    this._log(`Runtime memory=${memory.toFixed(2)}mb`);
    this._log(`Runtime rpc calls=${JSON.stringify(rpcCalls)}`);
    this._log(`Runtime storage size=${storage?.size.toFixed(2)}kb`);
    this._log(
      `Runtime network requests=${networkStats.nbRequests} (${networkStats.nbThrottled} throttled)`
    );
    this._log(`Runtime network download=${networkStats.download.toFixed(2)}kb`);
    this._log(`Runtime network upload=${networkStats.upload.toFixed(2)}kb`);

    if (networkStats.nbThrottled > 0) {
      throttled.networkRequest =
        networkStats.nbRequests >= options.requestLimit;

      throttled.download =
        networkStats.download >= options.downloadLimit / 1024;
      throttled.upload = networkStats.upload >= options.uploadLimit / 1024;
    }

    if (success) {
      if (storage?.state === "updated") {
        throttled.storage = storage.size > options.storageLimit;
      }

      if (version === Web3FunctionVersion.V1_0_0) {
        return {
          success,
          version,
          result: result as Web3FunctionResultV1,
          storage: storage as Web3FunctionStorageWithSize,
          logs,
          duration,
          memory,
          rpcCalls,
          network: networkStats,
          throttled,
        };
      } else {
        return {
          success,
          version,
          result: result as Web3FunctionResultV2,
          storage: storage as Web3FunctionStorageWithSize,
          logs,
          duration,
          memory,
          rpcCalls,
          network: networkStats,
          throttled,
        };
      }
    } else {
      if (
        error &&
        error instanceof Web3FunctionRuntimeError &&
        error.throttledReason
      ) {
        throttled[error.throttledReason] = true;
      }

      return {
        success,
        version,
        error: error as Web3FunctionRuntimeError,
        logs,
        duration,
        memory,
        rpcCalls,
        network: networkStats,
        throttled,
      };
    }
  }

  private async _runInSandbox(
    script: string,
    version: Web3FunctionVersion,
    context: Web3FunctionContextData,
    options: Web3FunctionRunnerOptions,
    multiChainProviderConfig: MultiChainProviderConfig
  ): Promise<{ result: Web3FunctionResult; storage: Web3FunctionStorage }> {
    const SandBoxClass =
      options.runtime === "thread"
        ? Web3FunctionThreadSandbox
        : Web3FunctionDockerSandbox;
    this._sandbox = new SandBoxClass(
      {
        memoryLimit: options.memory,
      },
      options.showLogs ?? false,
      this._debug
    );

    const mountPath = randomUUID();
    const serverPort =
      options.serverPort ?? (await Web3FunctionNetHelper.getAvailablePort());

    const httpProxyPort = await Web3FunctionNetHelper.getAvailablePort();
    const httpProxyHost =
      options.runtime === "thread" ? "127.0.0.1" : "host.docker.internal";
    this._httpProxy = new Web3FunctionHttpProxy(
      options.downloadLimit,
      options.uploadLimit,
      options.requestLimit,
      this._debug
    );

    this._httpProxy.start(httpProxyPort);

    try {
      this._log(`Starting sandbox: ${script}`);
      await this._sandbox.start(
        script,
        version,
        serverPort,
        mountPath,
        httpProxyHost,
        httpProxyPort,
        options.blacklistedHosts
      );
    } catch (err) {
      this._log(`Fail to start Web3Function in sandbox ${err.message}`);
      throw new Error(`Web3Function failed to start sandbox: ${err.message}`);
    }

    // Attach process exit handler to clean runtime environment
    this._exitRemover = onExit(() => this.stop());

    // Proxy RPC provider
    const proxyProviderPort = await Web3FunctionNetHelper.getAvailablePort();
    this._proxyProvider = new Web3FunctionProxyProvider(
      "http://127.0.0.1",
      proxyProviderPort,
      options.rpcLimit,
      context.gelatoArgs.chainId,
      multiChainProviderConfig,
      this._debug
    );
    await this._proxyProvider.start();
    context.rpcProviderUrl = this._proxyProvider.getProxyUrl();

    // Override gelatoArgs according to schema version
    if (version === Web3FunctionVersion.V1_0_0) {
      context.gelatoArgs["blockTime"] = Math.floor(Date.now() / 1000);
    }

    // Start monitoring memory usage
    this._monitorMemoryUsage();

    this._client = new Web3FunctionHttpClient(
      "http://0.0.0.0",
      serverPort,
      mountPath,
      this._debug
    );
    try {
      await Promise.race([
        this._client.connect(START_TIMEOUT),
        this._sandbox?.waitForProcessEnd(), // Early exit if sandbox is crashed
      ]);
    } catch (err) {
      this._log(`Fail to connect to Web3Function ${err.message}`);
      throw new Error(
        `Web3Function start-up timeout (${
          START_TIMEOUT / 1000
        }s) \nMake sure you registered your onRun function correctly in your script.`
      );
    }

    return new Promise((resolve, reject) => {
      let isResolved = false;
      this._client?.emit("input_event", { action: "start", data: { context } });
      this._client?.on("error", async (error: Error) => {
        this._log(`Client error: ${error.message}`);
        try {
          await this.stop();
        } catch (err) {
          this._log(`Error stopping sandbox: ${err.message}`);
        }
      });
      this._client?.on("output_event", (event: Web3FunctionEvent) => {
        this._log(`Received event: ${event.action}`);
        switch (event.action) {
          case "result":
            isResolved = true;
            resolve(event.data);
            break;
          case "error":
            isResolved = true;
            reject(event.data.error);
            break;
          default:
            this._log(`Unknown event: ${event.action}`);
        }
      });

      // Stop waiting for result after timeout expire
      this._execTimeoutId = setTimeout(() => {
        reject(
          new Web3FunctionRuntimeError(
            `Web3Function exceed execution timeout (${
              options.timeout / 1000
            }s)`,
            "duration"
          )
        );
      }, options.timeout);

      // Listen to sandbox exit status code to detect runtime error
      this._sandbox?.waitForProcessEnd().then(async (signal: number) => {
        // Wait for result event to be received if it's racing with process exit signal
        if (!isResolved) await delay(100);

        if (!isResolved)
          if (signal === 0) {
            reject(new Error(`Web3Function exited without returning result`));
          } else if (signal === 250) {
            reject(
              new Web3FunctionRuntimeError(
                `Web3Function exited with code=${signal} (RPC requests limit exceeded)`,
                "rpcRequest"
              )
            );
          } else if (
            (options.runtime === "docker" && signal === 137) ||
            (options.runtime === "thread" && this._memory >= options.memory)
          ) {
            reject(
              new Web3FunctionRuntimeError(
                `Web3Function exited with code=${signal} (Memory limit exceeded)`,
                "memory"
              )
            );
          } else {
            reject(new Error(`Web3Function exited with code=${signal}`));
          }
      });
    });
  }

  private _monitorMemoryUsage() {
    this._memoryIntervalId = setInterval(async () => {
      try {
        const liveMemory = await this._sandbox?.getMemoryUsage();
        if (liveMemory && liveMemory > this._memory) this._memory = liveMemory;
      } catch (err) {
        // Ignore
      }
    }, 100);
  }

  private _validateResult(
    version: Web3FunctionVersion,
    result: Web3FunctionResult
  ) {
    const isValidData = (data: string) =>
      data.length >= 10 && data.slice(0, 2) === "0x";
    const throwError = (message: string) => {
      throw new Error(
        `Web3Function ${message}. Instead returned: ${JSON.stringify(result)}`
      );
    };

    // validate canExec & callData exists
    if (!Object.keys(result).includes("canExec")) {
      throwError("must return {canExec: bool}");
    }

    if (result.canExec && !Object.keys(result).includes("callData")) {
      const returnType =
        version === Web3FunctionVersion.V1_0_0
          ? "{canExec: bool, callData: string}"
          : "{canExec: bool, callData: {to: string, data: string}[]}";
      throwError(`must return ${returnType}`);
    }

    // validate callData contents
    if (version === Web3FunctionVersion.V1_0_0) {
      result = result as Web3FunctionResultV1;

      if (result.canExec && !isValidData(result.callData))
        throwError("returned invalid callData");
    } else {
      result = result as Web3FunctionResultV2;

      if (result.canExec) {
        if (!Array.isArray(result.callData))
          throwError(
            "must return {canExec: bool, callData: {to: string, data: string}[]}"
          );

        for (const { to, data, value } of result.callData) {
          if (!isAddress(to)) throwError("returned invalid to address");

          if (!isValidData(data)) throwError("returned invalid callData");

          if (value) {
            const isNumericString = /^\d+$/.test(value);
            if (!isNumericString)
              throwError("returned invalid value (must be numeric string)");
          }
        }
      }
    }
  }

  public async stop() {
    this._log("Stopping runtime environment...");
    if (this._sandbox) await this._sandbox.stop();
    if (this._client) this._client.end();
    if (this._proxyProvider) this._proxyProvider.stop();
    if (this._httpProxy) this._httpProxy.stop();
    if (this._execTimeoutId) clearTimeout(this._execTimeoutId);
    if (this._memoryIntervalId) clearInterval(this._memoryIntervalId);
    // Remove process exit handler
    this._exitRemover();
  }

  private _log(message: string) {
    if (this._debug) console.log(`Web3FunctionRunner: ${message}`);
  }
}
