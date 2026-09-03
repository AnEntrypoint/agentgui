const fs = require('fs');
const path = require('path');

const SKILL_MD_PATH = path.join(__dirname, 'SKILL.md');

function loadCanonicalSkill() {
  return fs.readFileSync(SKILL_MD_PATH, 'utf-8');
}

function renderPlatformSkill(platformName) {
  return `---
name: gm-${platformName}
description: AI-native software engineering via skill-driven orchestration on ${platformName}; bootstraps plugkit for task execution and session isolation
allowed-tools: Skill
---

See [gm-skill](../gm-skill/SKILL.md). All platforms share the same plugkit dispatch surface.
`;
}

module.exports = { loadCanonicalSkill, renderPlatformSkill, SKILL_MD_PATH };
