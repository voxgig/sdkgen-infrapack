# Implementation rationale

Provider provenance and package dependencies are derived from the same model version. Keeping the generated source repository, revision and package identity together makes the provider reproducible from its SDK.

Generate the provider's ignore file as content rather than relying on npm to distribute a template named `.gitignore`. The component is the authoritative source of that file.

An API-assigned `id` and a client-supplied key are different facts about a create. The API chooses the first and ignores one that is sent; the second is required by the create request and a create without it has an empty body. `rkOnCreate` separates them from the create request shape, and every emitted create, example and round-trip reads that one answer.

The name an unrelated API `id` is parked under is derived from the provider's own name, so an entity can already use it as a field, a parent path parameter or its own key. Where it does, nothing is parked and nothing is deleted from a write: the value belongs to the caller, and removing it strips a required parameter from every save.

Sources: [provider main](.sdk/src/cmp/seneca-provider/Main_seneca-provider.ts), [provider extras](.sdk/src/cmp/seneca-provider/Extras_seneca-provider.ts), [ignore-file generator](.sdk/src/cmp/seneca-provider/Gitignore_seneca-provider.ts).
