#!/usr/bin/env node

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.join(__dirname, 'agents', 'platform-architect-intake.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const apply = process.argv.includes('--apply');

const mongoScript = `
const manifest = ${JSON.stringify(manifest)};
const id = ObjectId(manifest.agentObjectId);
const agent = db.agents.findOne({ _id: id });
if (!agent) throw new Error('Configured agent was not found by object id.');
if (agent.name !== manifest.expectedName) throw new Error('Configured object id resolved to an unexpected agent name.');
const markerStart = '<!-- REQUEST_WORKSPACE_RULES_START -->';
const markerEnd = '<!-- REQUEST_WORKSPACE_RULES_END -->';
const appendix = manifest.instructionsAppendix;
const oldInstructions = agent.instructions || '';
let instructions = oldInstructions;
for (const replacement of manifest.instructionReplacements || []) {
  if (instructions.includes(replacement.from)) {
    instructions = instructions.replace(replacement.from, replacement.to);
  } else if (!instructions.includes(replacement.to)) {
    throw new Error('An expected existing instruction was not found; refusing to guess where to replace it.');
  }
}
if (instructions.includes(markerStart) && instructions.includes(markerEnd)) {
  const markerStartAt = instructions.indexOf(markerStart);
  const markerEndAt = instructions.indexOf(markerEnd, markerStartAt + markerStart.length);
  if (markerEndAt < 0) throw new Error('The request-workspace instruction block is malformed.');
  instructions = instructions.slice(0, markerStartAt) + appendix + instructions.slice(markerEndAt + markerEnd.length);
} else {
  instructions = [oldInstructions.trim(), appendix].filter(Boolean).join('\\n\\n');
}
const removedTools = new Set(manifest.removeTools || []);
const tools = Array.from(
  new Set([...(agent.tools || []).filter((tool) => !removedTools.has(tool)), ...manifest.tools]),
);
const changed = JSON.stringify(tools) !== JSON.stringify(agent.tools || []) || instructions !== oldInstructions;
if (!changed) {
  printjson({ status: 'already_synced', agent: agent.name, tools: manifest.tools });
} else if (${apply}) {
  const version = { ...agent };
  delete version._id;
  delete version.__v;
  delete version.versions;
  delete version.createdAt;
  delete version.updatedAt;
  db.agents.updateOne(
    { _id: id },
    { $set: { tools, instructions }, $push: { versions: version } },
  );
  printjson({ status: 'synced', agent: agent.name, tools: manifest.tools });
} else {
  printjson({ status: 'would_sync', agent: agent.name, tools: manifest.tools });
}
`;

try {
  const output = execFileSync(
    'docker',
    ['exec', 'chat-mongodb', 'mongosh', 'LibreChat', '--quiet', '--eval', mongoScript],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  process.stdout.write(output);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
