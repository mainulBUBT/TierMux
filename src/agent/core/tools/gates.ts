

import type { EditGate } from '../../../edits/applyEdit';
import type { CommandGate } from '../../../edits/commandGate';

let commandGate: CommandGate | undefined;

/** Called once at activation with the CommandGate extension.ts constructs. The EditGate
 *  parameter is accepted for the existing call sites but no tool reads it any more. */
export function setGates(_edit: EditGate, command: CommandGate): void {
  commandGate = command;
}

export function getCommandGate(): CommandGate {
  if (!commandGate) throw new Error('CommandGate not initialized.');
  return commandGate;
}
