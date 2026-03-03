/**
 * AI Scientist OS - Type Definitions
 * 集成到 Claw Mesh
 */

// ============ Tool Registry (Tokyo) ============

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: 'debug' | 'analysis' | 'visualization' | 'data' | 'compute';
  parameters: JSONSchema;
  mcp_endpoint?: string;
  examples: ToolExample[];
}

export interface ToolExample {
  input: string;
  output: string;
  description: string;
}

export interface JSONSchema {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}

// ============ Planning (Silicon Valley) ============

export interface Task {
  id: string;
  description: string;
  steps: Step[];
  dependencies: string[];
  estimated_time: number;
  priority: 'high' | 'medium' | 'low';
}

export interface Step {
  id: string;
  action: string;
  tool: string;
  params: Record<string, any>;
  expected_output: string;
  fallback?: Step;
}

export interface Plan {
  task_id: string;
  steps: Step[];
  dag: DAGNode[];
  verification: VerificationRule[];
}

export interface DAGNode {
  id: string;
  step_id: string;
  dependencies: string[];
  parallel_group?: number;
}

// ============ Visualization (Central) ============

export interface MermaidDiagram {
  type: 'flowchart' | 'sequence' | 'gantt';
  content: string;
  metadata: {
    task_id: string;
    timestamp: number;
  };
}
