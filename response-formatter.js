/**
 * Response formatter for Claude Code outputs
 * Handles segmentation of text, code blocks, tool calls, thinking blocks, etc.
 */

export class ResponseFormatter {
  /**
   * Parse Claude Code response into structured segments
   */
  static parseResponse(text) {
    if (!text || typeof text !== 'string') return [];
    
    const segments = [];
    const lines = text.split('\n');
    let current = null;
    let codeBlockLang = null;
    let inCodeBlock = false;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check for code block markers
      const codeBlockMatch = line.match(/^```(\w+)?$/);
      if (codeBlockMatch) {
        if (!inCodeBlock) {
          // Starting a code block
          if (current && current.type === 'text' && current.content.trim()) {
            segments.push(current);
            current = null;
          }
          inCodeBlock = true;
          codeBlockLang = codeBlockMatch[1] || 'text';
          current = { type: 'code', language: codeBlockLang, content: '' };
        } else {
          // Ending a code block
          if (current) {
            segments.push(current);
            current = null;
          }
          inCodeBlock = false;
          codeBlockLang = null;
        }
        continue;
      }
      
      if (inCodeBlock) {
        current.content += (current.content ? '\n' : '') + line;
      } else {
        // Check for markdown formatting
        if (line.match(/^#+\s/)) {
          // Heading
          if (current && current.type === 'text' && current.content.trim()) {
            segments.push(current);
          }
          segments.push({ type: 'heading', level: line.match(/^#+/)[0].length, content: line.replace(/^#+\s/, '') });
          current = null;
        } else if (line.match(/^>\s/) || line.match(/^-\s/) || line.match(/^\d+\.\s/)) {
          // Quote, bullet, or numbered list
          if (current && current.type === 'text') {
            segments.push(current);
          }
          if (line.match(/^>\s/)) {
            segments.push({ type: 'blockquote', content: line.replace(/^>\s/, '') });
          } else {
            segments.push({ type: 'list_item', content: line.replace(/^[-\d+.]\s+/, '') });
          }
          current = null;
        } else if (line.trim()) {
          // Regular text
          if (!current || current.type !== 'text') {
            if (current) segments.push(current);
            current = { type: 'text', content: line };
          } else {
            current.content += '\n' + line;
          }
        } else if (current && current.type === 'text' && current.content.trim()) {
          // Empty line - could indicate paragraph break
          current.content += '\n\n';
        }
      }
    }
    
    if (current) {
      segments.push(current);
    }
    
    return segments;
  }

  /**
   * Extract tool calls, thinking blocks, and task information
   */
  static extractMetadata(text) {
    if (!text || typeof text !== 'string') return { tools: [], thinking: [], tasks: [] };
    
    const metadata = {
      tools: [],
      thinking: [],
      tasks: [],
      subagents: []
    };
    
    // Find tool call patterns
    const toolPattern = /(?:^|\n)\s*(?:Using|Calling|Invoking|Running)\s+(?:the\s+)?(\w+(?:\s+\w+)*?)(?:\s+(?:tool|command|function))?\s*(?:with|to)?\s*(.+?)(?:\n|$)/gi;
    let match;
    while ((match = toolPattern.exec(text)) !== null) {
      metadata.tools.push({
        name: match[1].trim(),
        description: match[2]?.trim() || ''
      });
    }
    
    // Find thinking/reasoning blocks
    const thinkingPattern = /(?:thinking|reasoning|analyzing|considering)[\s:]+(.+?)(?:\n\n|$)/gi;
    while ((match = thinkingPattern.exec(text)) !== null) {
      metadata.thinking.push(match[1].trim());
    }
    
    // Find task references
    const taskPattern = /(?:task|step|doing)[\s:]+(.+?)(?:\n|$)/gi;
    while ((match = taskPattern.exec(text)) !== null) {
      metadata.tasks.push(match[1].trim());
    }
    
    // Find subagent references
    const subagentPattern = /(?:using|with|via)\s+(?:the\s+)?(\w+)\s+(?:subagent|agent)/gi;
    while ((match = subagentPattern.exec(text)) !== null) {
      metadata.subagents.push(match[1].trim());
    }
    
    return metadata;
  }

  /**
   * Segment a response into logical parts
   * Splits on natural boundaries like tool calls, thinking, etc.
   */
  static segmentResponse(text) {
    if (!text || typeof text !== 'string') return [];
    
    // First, extract XML tags
    const xmlSegments = this.extractXMLTags(text);
    if (xmlSegments.length > 0) {
      return xmlSegments;
    }
    
    // Otherwise, segment by intent and transitions
    const segments = [];
    const parts = this.segmentByIntent(text);
    
    // Parse each part
    for (const part of parts) {
      segments.push({
        ...part,
        parsed: this.parseResponse(part.text),
        metadata: this.extractMetadata(part.text)
      });
    }
    
    return segments;
  }

  /**
   * Extract XML-tagged content as separate segments
   */
  static extractXMLTags(text) {
    const xmlPattern = /<(thinking|tool_use|tool_result|result|action)[\s>]([\s\S]*?)<\/\1>/gi;
    const segments = [];
    let lastIndex = 0;
    let match;

    while ((match = xmlPattern.exec(text)) !== null) {
      const before = text.substring(lastIndex, match.index);
      if (before.trim()) {
        segments.push({ type: 'text', text: before.trim() });
      }

      const tagType = match[1].toLowerCase();
      const tagContent = match[2].trim();
      segments.push({ type: tagType, text: tagContent });
      lastIndex = xmlPattern.lastIndex;
    }

    if (lastIndex < text.length) {
      const remaining = text.substring(lastIndex).trim();
      if (remaining) {
        segments.push({ type: 'text', text: remaining });
      }
    }

    return segments.length > 0 ? segments : [];
  }

  /**
   * Segment by semantic intent/actions
   */
  static segmentByIntent(text) {
    const segments = [];
    const intentPatterns = [
      { pattern: /^(Let me|I'll|I'm going to|First,?|Next,?|Now,?|Here's)/im, type: 'action' },
      { pattern: /^(Looking|Examining|Analyzing|Reviewing|Checking|Reading)/im, type: 'analysis' },
      { pattern: /^(Here'?s|Result|Output|Found|Got|Completed)/im, type: 'result' },
      { pattern: /^(The|This|That|These|Those)/im, type: 'explanation' }
    ];

    let currentSegment = '';
    let currentType = 'text';
    const lines = text.split('\n');

    for (const line of lines) {
      let newType = currentType;

      // Check for intent pattern match
      for (const { pattern, type } of intentPatterns) {
        if (pattern.test(line)) {
          newType = type;
          break;
        }
      }

      // If type changed and we have content, save segment
      if (newType !== currentType && currentSegment.trim()) {
        segments.push({ type: currentType, text: currentSegment.trim() });
        currentSegment = '';
        currentType = newType;
      }

      currentSegment += (currentSegment ? '\n' : '') + line;
    }

    // Add remaining segment
    if (currentSegment.trim()) {
      segments.push({ type: currentType, text: currentSegment.trim() });
    }

    return segments.length > 0 ? segments : [{ type: 'text', text }];
  }

  /**
   * Format segments for display with proper HTML
   */
  static formatForDisplay(segments) {
    if (!Array.isArray(segments)) return '';
    
    const html = [];
    
    for (const segment of segments) {
      if (segment.type === 'code') {
        html.push(`<pre class="code-block language-${segment.language}"><code>${this.escapeHtml(segment.content)}</code></pre>`);
      } else if (segment.type === 'heading') {
        const tag = `h${Math.min(segment.level, 6)}`;
        html.push(`<${tag} class="response-heading">${this.escapeHtml(segment.content)}</${tag}>`);
      } else if (segment.type === 'blockquote') {
        html.push(`<blockquote class="response-quote">${this.escapeHtml(segment.content)}</blockquote>`);
      } else if (segment.type === 'list_item') {
        html.push(`<li class="response-list-item">${this.escapeHtml(segment.content)}</li>`);
      } else if (segment.type === 'text') {
        html.push(`<p class="response-text">${this.escapeHtml(segment.content).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>')}</p>`);
      }
    }
    
    return html.join('\n');
  }

  static escapeHtml(text) {
    if (typeof text !== 'string') return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Create rich metadata display
   */
  static createMetadataDisplay(metadata) {
    if (!metadata || Object.keys(metadata).every(k => !metadata[k] || metadata[k].length === 0)) {
      return null;
    }

    const html = ['<div class="response-metadata">'];
    
    if (metadata.tools?.length) {
      html.push('<div class="metadata-section tools">');
      html.push('<strong>Tools Used:</strong>');
      html.push('<ul>');
      for (const tool of metadata.tools) {
        html.push(`<li><code>${this.escapeHtml(tool.name)}</code>${tool.description ? ': ' + this.escapeHtml(tool.description) : ''}</li>`);
      }
      html.push('</ul></div>');
    }
    
    if (metadata.thinking?.length) {
      html.push('<details class="metadata-section thinking">');
      html.push('<summary>Reasoning</summary>');
      for (const thought of metadata.thinking) {
        html.push(`<p>${this.escapeHtml(thought)}</p>`);
      }
      html.push('</details>');
    }
    
    if (metadata.subagents?.length) {
      html.push('<div class="metadata-section subagents">');
      html.push('<strong>Subagents:</strong>');
      html.push('<ul>');
      for (const agent of metadata.subagents) {
        html.push(`<li>${this.escapeHtml(agent)}</li>`);
      }
      html.push('</ul></div>');
    }
    
    if (metadata.tasks?.length) {
      html.push('<div class="metadata-section tasks">');
      html.push('<strong>Tasks:</strong>');
      html.push('<ul>');
      for (const task of metadata.tasks) {
        html.push(`<li>${this.escapeHtml(task)}</li>`);
      }
      html.push('</ul></div>');
    }
    
    html.push('</div>');
    return html.join('\n');
  }
}

export default ResponseFormatter;
