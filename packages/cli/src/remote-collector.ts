import type {
  AcknowledgementResponse,
  AcknowledgeRequest,
  CheckRequest,
  CheckResponse,
  RemovedAcknowledgementResponse,
  StateResponse,
} from "@ephorate/core";
import { ApiClient } from "./api-client";
import { openTunnel, type Tunnel } from "./tunnel";

interface RemoteCollectorOptions {
  remote: string;
  remotePort: number;
  token: string;
  /** Where the token came from, said when it is rejected. */
  tokenSource: string;
  /** `openTunnel`; a test puts its own in place. */
  open?: typeof openTunnel | undefined;
}

/**
 * The collector on another machine, through an ssh tunnel opened at the
 * first request and again after ssh died: `watch` outlives a dropped link.
 */
export class RemoteCollector {
  /** Not loopback, so `check` never takes a dead remote for no daemon. */
  readonly apiUrl: string;
  private tunnel: Tunnel | undefined;
  private opening: Promise<Tunnel> | undefined;

  constructor(private readonly options: RemoteCollectorOptions) {
    this.apiUrl = `ssh://${options.remote}`;
  }

  state(): Promise<StateResponse> {
    return this.call((client) => client.state());
  }

  check(request: CheckRequest): Promise<CheckResponse> {
    return this.call((client) => client.check(request));
  }

  acknowledge(
    node: string,
    request: AcknowledgeRequest,
  ): Promise<AcknowledgementResponse> {
    return this.call((client) => client.acknowledge(node, request));
  }

  unacknowledge(node: string): Promise<RemovedAcknowledgementResponse> {
    return this.call((client) => client.unacknowledge(node));
  }

  close(): void {
    this.tunnel?.close();
    this.tunnel = undefined;
  }

  private async call<T>(
    request: (client: ApiClient) => Promise<T>,
  ): Promise<T> {
    const tunnel = await this.openTunnel();
    const { remote, remotePort, token, tokenSource } = this.options;

    return request(
      new ApiClient({
        apiUrl: tunnel.url,
        token,
        tunnel: { remote, remotePort, tokenSource },
      }),
    );
  }

  // One tunnel at a time: `watch` polls while a slow ssh is still opening.
  private async openTunnel(): Promise<Tunnel> {
    if (this.tunnel?.isOpen()) return this.tunnel;

    this.opening ??= (this.options.open ?? openTunnel)({
      remote: this.options.remote,
      remotePort: this.options.remotePort,
    }).finally(() => {
      this.opening = undefined;
    });
    this.tunnel = await this.opening;

    return this.tunnel;
  }
}
