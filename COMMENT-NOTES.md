# Implementation rationale

Provider provenance and package dependencies are derived from the same model version. Keeping the generated source repository, revision and package identity together makes the provider reproducible from its SDK.

Generate the provider's ignore file as content rather than relying on npm to distribute a template named `.gitignore`. The component is the authoritative source of that file.

An API-assigned `id` and a client-supplied key are different facts about a create. The API chooses the first and ignores one that is sent; the second is required by the create request and a create without it has an empty body. `rkOnCreate` separates them from the create request shape, and every emitted create, example and round-trip reads that one answer.

The name an unrelated API `id` is parked under is derived from the provider's own name, so an entity can already use it as a field, a parent path parameter or its own key. Where it does, nothing is parked and nothing is deleted from a write: the value belongs to the caller, and removing it strips a required parameter from every save.

An operation whose every route is an action has no route of its own, and the SDK sends that action for the plain call. The provider treats such an operation as absent wherever it routes or documents a plain call, keeps the command while an action reaches it, and refuses the plain call by name. A save without an id names no record to update, so where the only create route is an action it is refused; with an id it still updates.

Sources: [provider main](.sdk/src/cmp/seneca-provider/Main_seneca-provider.ts), [provider extras](.sdk/src/cmp/seneca-provider/Extras_seneca-provider.ts), [ignore-file generator](.sdk/src/cmp/seneca-provider/Gitignore_seneca-provider.ts).

## Postman collections

The collections are derived from the model, not from the API definition, so a request sends what the SDK sends. The definition is read only where generation has it, to sample request bodies with its enums and examples. A test kit generation never has it, and the model-only path is the one the generation tests exercise end to end.

A path placeholder keeps the definition's name in the URL, paired with the model's name for it by position in the route: apidef records a rename in `r.param` but not always in `or`, and the two can differ for an ancestor's key as well as for the record's own.

Every route that names a record binds it to that entity's variable, so a variable set once serves every request in every folder that addresses the record. A composite key holds one variable per part, read back from where the record keeps that part.

A blocked flow step is skipped, never thrown: Postman still sends a request whose pre-request script throws, with each unset variable on the wire. Each step carries its own guard rather than calling one defined in a collection script, so it guards itself however Postman scopes scripts. A path variable's value lives outside the URL text, so a step's needs come from its path variables as well as from its URL, headers and body.

Credentials are environment slots only, and an exchanged token is a run-scoped variable, so no script writes a secret where Postman saves it to a file.

Ids are derived from what each file names, so regenerating an unchanged model rewrites nothing.

Sources: [postman main](.sdk/src/cmp/postman/Main_postman.ts), [derivation](.sdk/src/cmp/postman/Catalogue_postman.ts), [collections](.sdk/src/cmp/postman/Collection_postman.ts).
