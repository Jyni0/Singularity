import { Model, Provider, Gateway, prettyModelName } from "../core/types.i";

/** Groups providers and their models into the shape the pickers consume. */
export function toGateways(providers: Provider[], models: Model[]): Gateway[] {
  return providers.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    status: p.status,
    enabled: p.enabled,
    models: models
      .filter((m) => m.provider_id === p.id && m.enabled)
      .map((m) => ({
        id: m.model_id,
        // Display names are humanized (`claude-fable-5` → `Claude Fable 5`)
        // unless the user gave the model a custom name of their own.
        name:
          m.name && m.name !== m.model_id ? m.name : prettyModelName(m.model_id),
        meta: m.meta,
      })),
  }));
}
