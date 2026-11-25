/**
 * Antigravity (2.0 / IDE / CLI) templates
 *
 * Directory structure:
 *   antigravity/
 *   ├── agents/      # Custom sub-agent definitions (.agents/agents/*.md)
 *   └── hooks.json   # Lifecycle hooks configuration (.agents/hooks.json)
 */

import { createTemplateReader, type AgentTemplate } from "../template-utils.js";
export type { AgentTemplate };

const { listMdAgents, getConfig } = createTemplateReader(import.meta.url);

export const getAllAgents = (): AgentTemplate[] => listMdAgents();
export const getHooksConfig = (): string => getConfig("hooks.json");
