import { BigNumber } from "@ethersproject/bignumber";
import { diff } from "deep-object-diff";
import { Web3FunctionHttpServer } from "./net/Web3FunctionHttpServer";
import "./polyfill/XMLHttpRequest";
import { Web3FunctionMultiChainProvider } from "./provider/Web3FunctionMultiChainProvider";
import {
  Web3FunctionContext,
  Web3FunctionContextData,
  Web3FunctionEventContext,
} from "./types/Web3FunctionContext";
import { Web3FunctionEvent } from "./types/Web3FunctionEvent";
import { Web3FunctionResult } from "./types/Web3FunctionResult";

type baseRunHandler = (ctx: Web3FunctionContext) => Promise<Web3FunctionResult>;
type eventRunHandler = (
  ctx: Web3FunctionEventContext
) => Promise<Web3FunctionResult>;

type runHandler = baseRunHandler | eventRunHandler;

export class Web3Function {
  private static Instance?: Web3Function;
  private static _debug = false;
  private _server: Web3FunctionHttpServer;
  private _onRun?: runHandler;

  constructor() {
    const port = Number(Deno.env.get("WEB3_FUNCTION_SERVER_PORT") ?? 80);
    const mountPath = Deno.env.get("WEB3_FUNCTION_MOUNT_PATH");
    this._server = new Web3FunctionHttpServer(
      port,
      mountPath,
      Web3Function._debug,
      this._onFunctionEvent.bind(this)
    );
  }

  private async _onFunctionEvent(
    event: Web3FunctionEvent
  ): Promise<Web3FunctionEvent> {
    switch (event?.action) {
      case "start": {
        const prevStorage = { ...event.data.context.storage };

        try {
          const { result, ctxData } = await this._run(event.data.context);

          const difference = diff(prevStorage, ctxData.storage);
          for (const key in difference) {
            if (difference[key] === undefined) {
              difference[key] = null;
            }
          }

          const state =
            Object.keys(difference).length === 0 ? "last" : "updated";

          return {
            action: "result",
            data: {
              result,
              storage: {
                state,
                storage: ctxData.storage,
                diff: difference,
              },
            },
          };
        } catch (error) {
          return {
            action: "error",
            data: {
              error: {
                name: error.name,
                message: `${error.name}: ${error.message}`,
              },
              storage: {
                state: "last",
                storage: prevStorage,
                diff: {},
              },
            },
          };
        } finally {
          this._exit();
        }
        break;
      }
      default:
        Web3Function._log(`Unrecognized parent process event: ${event.action}`);
        throw new Error(`Unrecognized parent process event: ${event.action}`);
    }
  }

  private async _run(ctxData: Web3FunctionContextData) {
    if (!this._onRun)
      throw new Error("Web3Function.onRun function is not registered");

    const context: Web3FunctionContext = {
      gelatoArgs: {
        ...ctxData.gelatoArgs,
        gasPrice: BigNumber.from(ctxData.gelatoArgs.gasPrice),
      },
      multiChainProvider: this._initProvider(
        ctxData.rpcProviderUrl,
        ctxData.gelatoArgs.chainId
      ),
      userArgs: ctxData.userArgs,
      secrets: {
        get: async (key: string) => {
          Web3Function._log(`secrets.get(${key})`);
          return ctxData.secrets[key];
        },
      },
      storage: {
        get: async (key: string) => {
          Web3Function._log(`storage.get(${key})`);
          return ctxData.storage[key];
        },
        set: async (key: string, value: string) => {
          if (typeof value !== "string") {
            throw new Error("Web3FunctionStorageError: value must be a string");
          }
          Web3Function._log(`storage.set(${key},${value})`);
          ctxData.storage[key] = value;
        },
        delete: async (key: string) => {
          Web3Function._log(`storage.delete(${key})`);
          ctxData.storage[key] = undefined;
        },
      },
    };

    const result = ctxData.log
      ? await (this._onRun as eventRunHandler)({ ...context, log: ctxData.log })
      : await (this._onRun as baseRunHandler)(context);

    return { result, ctxData };
  }

  private _exit(code = 0, force = false) {
    if (force) {
      Deno.exit(code);
    } else {
      setTimeout(async () => {
        await this._server.waitConnectionReleased();
        Deno.exit(code);
      });
    }
  }

  static getInstance(): Web3Function {
    if (!Web3Function.Instance) {
      Web3Function.Instance = new Web3Function();
    }
    return Web3Function.Instance;
  }

  static onRun(onRun: baseRunHandler): void;
  static onRun(onRun: eventRunHandler): void;
  static onRun(onRun: any): void {
    Web3Function._log("Registering onRun function");
    Web3Function.getInstance()._onRun = onRun;
  }

  static setDebug(debug: boolean) {
    Web3Function._debug = debug;
  }

  private static _log(message: string) {
    if (Web3Function._debug) console.log(`Web3Function: ${message}`);
  }

  private _onRpcRateLimit() {
    console.log("_onRpcRateLimit");
    this._exit(250, true);
  }

  private _initProvider(
    providerUrl: string | undefined,
    defaultChainId: number
  ): Web3FunctionMultiChainProvider {
    if (!providerUrl) throw new Error("Missing providerUrl");
    return new Web3FunctionMultiChainProvider(
      providerUrl,
      defaultChainId,
      this._onRpcRateLimit.bind(this)
    );
  }
}
