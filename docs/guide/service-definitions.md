---
title: Service definitions
---

# Service definitions

A client receives the service definitions it needs when it connects, so most programs never handle them. They are available for tools, such as user interfaces generated from a definition.

## Parsing

{@link robotraconteur!parseServiceDefinition | parseServiceDefinition} reads the text of a `.robdef` file:

```ts
import { parseServiceDefinition } from "robotraconteur";

const def = parseServiceDefinition(text);
console.log(def.name, def.objects.map((o) => o.name));
```

The result is plain data, described by `service-definition.schema.json` in the package, so it can be stored as JSON. Documentation from `##` comments is kept in each `docString`. The parser checks the syntax and throws {@link robotraconteur!ServiceDefinitionParseError | ServiceDefinitionParseError}, which has the line number.

The definitions of a connected service are in `client.context.types.defs`, and `client.context.serviceDefForType(client.objectType)` gives the definition of an object.

## Checking

The parser does not check that names are defined, that values are in range, or that entries are in the order Core requires. Those checks are a separate entry point, `robotraconteur/validators`, so that they are only bundled when used:

```ts
import { verifyServiceDefinition, verifyServiceDefinitionOrder, verifyServiceDefinitions } from "robotraconteur/validators";

verifyServiceDefinition(def, imported);   // one definition, with the definitions it imports
verifyServiceDefinitions([a, b, c]);      // a set that may import each other
verifyServiceDefinitionOrder(text);       // the order of entries in the text
```

They throw `ServiceDefinitionVerifyError`. Services written with robotraconteur-node check the order automatically, since Core clients reject definitions in another order.
