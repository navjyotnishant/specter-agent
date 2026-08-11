import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/overview',
        'getting-started/local-operations',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      items: [
        'guides/workflow-execution',
        'guides/docker-sandbox',
        'guides/codex-cli-host-runner',
      ],
    },
    {
      type: 'category',
      label: 'Architecture',
      items: [
        'architecture/project-summary',
        'architecture/execution-engine',
        'architecture/graph-runner-port',
      ],
    },
    {
      type: 'category',
      label: 'Contributing',
      items: [
        'contributing/agent-instructions',
        'contributing/ai-rules',
      ],
    },
  ],
};

export default sidebars;
