import { getDefinition, type DefinitionKey } from "@/lib/definitions";
import { InfoPopover } from "./overlays";

/** Info button showing the formula for a derived value, text generated from docs/05. */
export function DefinitionTip({ term }: { term: DefinitionKey }) {
  const d = getDefinition(term);
  return (
    <InfoPopover label={`Definition of ${d.label}`} testId={`definition-${term}`}>
      <span className="block text-caption text-text-1">{d.text}</span>
      <span className="mt-1 block text-micro text-text-2">
        Source: analytics spec section {d.section}
      </span>
    </InfoPopover>
  );
}
