import { invariant } from "ts-invariant";

import { createClient } from "graphql-ws";
import {
  Environment,
  Network,
  Observable,
  RecordSource,
  RequestParameters,
  Store,
  Variables,
} from "relay-runtime";

import { IDENTITY_HEADERS } from "./api";

// Who is asking, for the server's admin checks: the display sends its secret,
// a phone its device ID and nickname (percent-encoded, since a nickname may
// not be ASCII).
function identityHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (window.karafriends !== undefined) {
    const token = window.karafriends.displayToken();
    if (token) headers[IDENTITY_HEADERS.displayToken] = token;
    return headers;
  }
  try {
    const deviceId = localStorage.getItem("deviceId");
    const nickname = localStorage.getItem("nickname");
    if (deviceId) {
      headers[IDENTITY_HEADERS.deviceId] = encodeURIComponent(deviceId);
    }
    if (nickname) {
      headers[IDENTITY_HEADERS.nickname] = encodeURIComponent(nickname);
    }
  } catch {
    // No localStorage (e.g. blocked): ask anonymously.
  }
  return headers;
}

function fetchQuery(request: RequestParameters, variables: Variables) {
  return fetch(
    window.karafriends !== undefined
      ? `http://localhost:${
          window.karafriends.karafriendsConfig().remoconPort
        }/graphql`
      : "/graphql",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...identityHeaders(),
      },
      body: JSON.stringify({
        query: request.text,
        variables,
      }),
    },
  ).then((response) => {
    return response.json();
  });
}

function getSubscriptionUrl(): string {
  if (window.karafriends !== undefined) {
    return `ws://localhost:${
      window.karafriends.karafriendsConfig().remoconPort
    }/graphql`;
  }

  const wsProtocol = window.location.protocol === "https:" ? "wss" : "ws";

  return `${wsProtocol}://${window.location.hostname}:${window.location.port}/graphql`;
}

const subscriptionClient = createClient({
  url: getSubscriptionUrl(),
  shouldRetry: () => true,
});

const subscribe = (operation: RequestParameters, variables: Variables) => {
  return Observable.create((sink) => {
    invariant(operation.text);

    return subscriptionClient.subscribe(
      {
        operationName: operation.name,
        query: operation.text,
        variables,
      },
      sink,
    );
  });
};

const environment = new Environment({
  // @ts-ignore: the relay type stubs are pitifully broken
  network: Network.create(fetchQuery, subscribe),
  store: new Store(new RecordSource()),
});

export default environment;
