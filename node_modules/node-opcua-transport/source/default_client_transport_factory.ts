/**
 * @module node-opcua-transport
 */

import { ClientTCP_transport, type TransportSettingsOptions } from "./client_tcp_transport";
import type { IClientTransport, IClientTransportFactory } from "./i_client_transport";

/**
 * The default client-transport factory, which returns a {@link ClientTCP_transport}.
 *
 * This is the implicit factory used by {@link ClientSecureChannelLayer} when no
 * `transportFactory` option is provided, preserving the historical (Node-only)
 * behavior byte-for-byte.
 */
export const defaultClientTransportFactory: IClientTransportFactory = {
    create(settings?: TransportSettingsOptions): IClientTransport {
        return new ClientTCP_transport(settings) as IClientTransport;
    }
};
