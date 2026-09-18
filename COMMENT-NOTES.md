# Implementation rationale

Provider provenance and package dependencies are derived from the same model version. Keeping the generated source repository, revision and package identity together makes the provider reproducible from its SDK.

Generate the provider's ignore file as content rather than relying on npm to distribute a template named `.gitignore`. The component is the authoritative source of that file.

Sources: [provider extras](.sdk/src/cmp/seneca-provider/Extras_seneca-provider.ts), [ignore-file generator](.sdk/src/cmp/seneca-provider/Gitignore_seneca-provider.ts).
