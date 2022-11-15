import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import tar from "tar";
import FormData from "form-data";
import axios from "axios";
import { Wallet } from "ethers";
import { SiweMessage } from "siwe";

const OPS_USER_API = process.env.OPS_USER_API;
export class JsResolverUploader {
  public static async uploadResolver(
    wallet: Wallet,
    schemaPath = "src/resolvers/schema.json",
    input = ".tmp/resolver.cjs"
  ): Promise<string | null> {
    let cid: string | null = null;

    try {
      await fsp.access(input);
      await this.compress(input, schemaPath);

      const authToken = await this._signMessage(wallet);
      cid = await this._userApiUpload(wallet.address, authToken);
    } catch (err) {
      console.error("Error uploading: ", err);
    }

    return cid;
  }

  public static async fetchResolver(
    wallet: Wallet,
    cid: string,
    filePath = "./.tmp"
  ): Promise<string> {
    try {
      if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath, { recursive: true });
      }

      const authToken = await this._signMessage(wallet);
      const res = await axios.get(
        `${OPS_USER_API}/users/${wallet.address}/js-resolver/${cid}`,
        {
          responseEncoding: "binary",
          responseType: "arraybuffer",
          headers: { Authorization: authToken },
        }
      );

      const jsResolverFileName = `${cid}.tgz`;
      fs.writeFile(jsResolverFileName, res.data, (err) => {
        if (err) throw err;
      });

      const jsResolverDir = `${filePath}/${jsResolverFileName}`;
      await fsp.rename(jsResolverFileName, jsResolverDir);

      return jsResolverDir;
    } catch (err) {
      let errMsg = `${err.message} `;
      if (axios.isAxiosError(err)) {
        const data = JSON.parse(err.response?.data.toString("utf8")) as {
          message?: string;
        };
        if (data.message) errMsg += data.message;
      }

      console.error(`Error fetching JsResolver: `, errMsg);
    }
    return "";
  }

  public static async compress(
    input: string,
    schemaPath: string
  ): Promise<void> {
    try {
      const { base } = path.parse(input);

      // create directory with jsResolver.cjs & schema
      const folderCompressedName = "jsResolver";
      const folderCompressedTar = `${folderCompressedName}.tgz`;
      if (!fs.existsSync(folderCompressedName)) {
        fs.mkdirSync(folderCompressedName, { recursive: true });
      }

      // move files to directory
      await fsp.rename(input, `${folderCompressedName}/${base}`);
      await fsp.copyFile(schemaPath, `${folderCompressedName}/schema.json`);

      const stream = tar
        .c(
          {
            gzip: true,
          },
          [folderCompressedName]
        )
        .pipe(fs.createWriteStream(`.tmp/${folderCompressedTar}`));

      await new Promise((fulfill) => {
        stream.once("finish", fulfill);
      });

      // delete directory after compression
      await fsp.rm(folderCompressedName, { recursive: true });
    } catch (err) {
      console.error(`Error compressing JSResolver: `, err);
    }
  }

  public static async extract(input: string): Promise<void> {
    try {
      const { dir } = path.parse(input);

      tar.x({ file: `${input}`, sync: true, cwd: dir });
    } catch (err) {
      console.error(`Error extracting JSResolver: `, err);
    }
  }

  private static async _userApiUpload(
    address: string,
    authToken: string
  ): Promise<string | null> {
    let cid: string | null = null;
    try {
      const form = new FormData();
      const file = fs.createReadStream(".tmp/jsResolver.tgz");

      form.append("title", "JsResolver");
      form.append("file", file);

      const res = await axios.post(
        `${OPS_USER_API}/users/${address}/js-resolver`,
        form,
        {
          ...form.getHeaders(),
          headers: { Authorization: authToken },
        }
      );

      cid = res.data.cid;
    } catch (err) {
      let errMsg = `${err.message} `;
      if (axios.isAxiosError(err)) {
        const data = err?.response?.data as { message?: string };
        if (data.message) errMsg += data.message;
      }

      console.error(`Error uploading JSResolver: `, errMsg);
    }

    return cid;
  }

  private static async _signMessage(wallet: Wallet): Promise<string> {
    let authToken = "";
    try {
      const domain = "app.gelato.network";
      const uri = "http://app.gelato.network/";
      const address = wallet.address;
      const version = "1";
      const chainId = 1;
      const expirationTime = new Date(Date.now() + 600_000).toISOString();
      const statement = "Sign this message to upload/fetch JsResolver";

      const siweMessage = new SiweMessage({
        domain,
        statement,
        uri,
        address,
        version,
        chainId,
        expirationTime,
      });

      const message = siweMessage.prepareMessage();
      const signature = await wallet.signMessage(message);

      authToken = Buffer.from(JSON.stringify({ message, signature })).toString(
        "base64"
      );
    } catch (err) {
      console.error("Error signing message: ", err);
    }

    return authToken;
  }
}
