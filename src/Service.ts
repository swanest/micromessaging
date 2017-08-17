import { ServiceOptions } from "./Interfaces";
import { Messaging } from "./Messaging";
export class Service extends Messaging {
  /**
   * @constructor
   * @param {string} serviceName
   * @param {ServiceOptions} options
   */
  constructor(serviceName: string, options?: ServiceOptions) {
    super(serviceName, options);
    this._logger.warn("Using deprecated class Service. Use Messaging instead!");
  }
}
