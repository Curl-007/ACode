# v4 capability query

## Scope

`independentPlanSupport` is a service-side preflight for commands that carry
independent Plan state. The preflight must ask the CLI through a strict v4 RPC
method; it must not infer support from a host hello or from the legacy
`runtime/capabilities` response.

## Contract

- Method: `v4/capabilities/query`.
- Params: strict `{ capability: "independentPlanState" }`.
- Result: strict `{ capability: "independentPlanState", supported: boolean }`.
- The CLI route is the single owner of the capability fact. It returns
  `supported: true` only for the schema-declared key.
- Unknown keys, missing fields, extra fields, malformed results, `false`, and
  JSON-RPC `-32601` are all unsupported. The service exposes the stable error
  `proto.independentPlanUnsupported` and never allows the Plan command through.

## Concurrency and retry

The service keeps one in-flight/completed check per protocol client in a
`WeakMap`. Concurrent callers share the same promise and produce one request.
The promise is removed when the request rejects or the result is unsupported,
so a later call can retry after a CLI restart or upgrade. A successful result
remains cached for that client lifetime.

## Migration boundary

This slice changes only the independent Plan preflight. Other legacy services
methods remain unchanged until their own v4 contracts are migrated. The old
`runtime/capabilities` method is intentionally not used by this path.
