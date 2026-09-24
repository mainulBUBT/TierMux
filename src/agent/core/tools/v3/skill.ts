// skill — the model loads an installed skill by name, the way Claude Code's Skill tool does.
// Only name + description sit in the tool description; the body arrives when the model calls it.

import { tool } from 'ai';
import { z } from 'zod';
import { skillInstructions, type Skill } from '../../../../context/skills';
import { registerReadableRoot } from '../resolvePath';

const DESCRIPTION_CAP = 200;

export function createSkillTool(skills: Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s]));
  const listing = skills
    .map((s) => {
      const d = s.description.length > DESCRIPTION_CAP ? `${s.description.slice(0, DESCRIPTION_CAP)}…` : s.description;
      return `- ${s.name}${d ? `: ${d}` : ''}`;
    })
    .join('\n');
  return tool({
    description:
      'Load an installed skill: a packaged set of instructions for a particular kind of task. '
      + 'When the task at hand matches a skill below, call this first and follow the instructions '
      + 'it returns. Available skills:\n' + listing,
    inputSchema: z.object({
      name: z.string().min(1).describe('Exact skill name from the list, without a leading slash.'),
    }),
    execute: async ({ name }) => {
      const skill = byName.get(name.replace(/^\//, '').trim().toLowerCase());
      if (!skill) return { error: `No skill named "${name}". Available: ${[...byName.keys()].join(', ')}` };
      // A skill's references/ and scripts/ may live outside the workspace.
      registerReadableRoot(skill.dir);
      return { skill: skill.name, instructions: skillInstructions(skill) };
    },
  });
}
