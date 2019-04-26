import * as stream from 'stream';
import * as util from 'util';
import * as zlib from 'zlib';

export class Utils {

    public static async compress(stream: stream.Readable): Promise<Buffer> {
        const output = zlib.createGzip();
        stream.pipe(output);
        return Utils.streamToBuffer(output);
    }

    public static hrtimeToMS(time: [number, number]): number {
        return (time[0] * 1e9 + time[1]) / 1e6;
    }

    public static async streamToBuffer(stream: stream.Readable): Promise<Buffer> {

        if (!stream.readable) {
            return Promise.resolve<Buffer>(Buffer.from(''));
        }
        return new Promise<Buffer>(function (resolve, reject) {
            // stream is already ended
            if (!stream.readable) {
                return resolve(Buffer.from(''));
            }

            let arr: Array<Buffer> = [];

            stream.on('data', onData);
            stream.on('end', onEnd);
            stream.on('error', onEnd);
            stream.on('close', onClose);

            function onData(chunk: Buffer | string) {
                arr.push(util.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }

            function onEnd(err?: Error) {
                if (err) {
                    reject(err);
                } else {
                    resolve(Buffer.concat(arr));
                }
                cleanup();
            }

            function onClose() {
                resolve(Buffer.concat(arr));
                cleanup();
            }

            function cleanup() {
                arr = null;
                stream.removeListener('data', onData);
                stream.removeListener('end', onEnd);
                stream.removeListener('error', onEnd);
                stream.removeListener('close', onClose);
            }
        });
    }

    public static uncompress(buffer: Buffer): Buffer {
        return zlib.gunzipSync(buffer);
    }
}

/**
 * Waits for `ms` milliseconds, then resolves
 * @param ms Number of milliseconds
 */
export const wait = (ms: number) => new Promise((r, j) => setTimeout(r, ms));
