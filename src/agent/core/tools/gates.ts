

import type { EditGate } from '../../../edits/applyEdit';
import type { CommandGate } from '../../../edits/commandGate';

let editGate: EditGate | undefined;
let commandGate: CommandGate | undefined;

/** Wires the agent's write/edit/delete/bash tools to the SAME EditGate/CommandGate instances
 *  extension.ts already constructs (with their settings/allowlist/shell-manager wiring intact) —
 *  called once at activation. */
export function setGates(edit: EditGate, command: CommandGate): void {
  editGate = edit;
  commandGate = command;
}

export function getEditGate(): EditGate {
  if (!editGate) throw new Error('EditGate not initialized.');
  return editGate;
}

export function getCommandGate(): CommandGate {
  if (!commandGate) throw new Error('CommandGate not initialized.');
  return commandGate;
}
