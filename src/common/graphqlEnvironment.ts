// Relay, for the lookups and commands that haven't moved to the JSON RPC API
// yet (Phase 5d). Live state comes from apiClient.ts.
import {
  Environment,
  Network,
  RecordSource,
  RequestParameters,
  Store,
  Variables,
} from "relay-runtime";

import { identityHeaders, serverUrl } from "./apiClient";

function fetchQuery(request: RequestParameters, variables: Variables) {
  return fetch(serverUrl("/graphql"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...identityHeaders(),
    },
    body: JSON.stringify({
      query: request.text,
      variables,
    }),
  }).then((response) => {
    return response.json();
  });
}

const environment = new Environment({
  // @ts-ignore: the relay type stubs are pitifully broken
  network: Network.create(fetchQuery),
  store: new Store(new RecordSource()),
});

export default environment;
