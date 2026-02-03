/**
 * HTML Wrapper for Claude Responses
 * Converts plain text/markdown responses into beautiful HTML
 */

export class HTMLWrapper {
  /**
   * Wrap plain text response in HTML with RippleUI styling
   */
  static wrapResponse(text) {
    if (!text || typeof text !== 'string') return text;
    
    // If already HTML, return as-is
    if (text.trim().startsWith('<')) return text;
    
    // Parse markdown-style text and convert to HTML
    const lines = text.split('\n');
    const html = this.parseMarkdownToHTML(lines);
    
    // Wrap in container
    return `<div class="space-y-4 p-6 max-w-4xl">${html}</div>`;
  }

  static parseMarkdownToHTML(lines) {
    let html = '';
    let inCodeBlock = false;
    let codeLanguage = 'text';
    let codeContent = '';
    let listItems = [];
    let inList = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Code blocks
      if (line.match(/^```(\w+)?$/)) {
        if (!inCodeBlock) {
          // Start code block
          inCodeBlock = true;
          codeLanguage = line.match(/```(\w+)?/)?.[1] || 'text';
          codeContent = '';
        } else {
          // End code block
          inCodeBlock = false;
          html += `<pre class="bg-gray-900 text-white p-4 rounded-lg overflow-x-auto"><code class="language-${codeLanguage}">${this.escapeHtml(codeContent)}</code></pre>`;
          codeContent = '';
        }
        continue;
      }

      if (inCodeBlock) {
        codeContent += (codeContent ? '\n' : '') + line;
        continue;
      }

      // Headings
      if (line.match(/^#+\s/)) {
        const level = line.match(/^#+/)[0].length;
        const heading = line.replace(/^#+\s/, '');
        html += `<h${level} class="text-${level === 1 ? '3xl' : level === 2 ? '2xl' : 'xl'} font-bold text-gray-900 mt-4">${this.escapeHtml(heading)}</h${level}>`;
        continue;
      }

      // Lists
      if (line.match(/^[-*•]\s/) || line.match(/^\d+\.\s/)) {
        const itemText = line.replace(/^[-*•\d+.]\s+/, '');
        if (!inList) {
          inList = true;
          listItems = [];
        }
        listItems.push(itemText);
        continue;
      } else if (inList && line.trim()) {
        // End list
        html += `<ul class="list-none space-y-2 ml-0"><li class="p-3 bg-gray-100 rounded border-l-4 border-blue-500">${listItems.map(item => `• ${this.escapeHtml(item)}`).join('</li><li class="p-3 bg-gray-100 rounded border-l-4 border-blue-500">')}</li></ul>`;
        inList = false;
        listItems = [];
      }

      // Empty lines
      if (!line.trim()) {
        if (!html.endsWith('</p>')) html += '<br>';
        continue;
      }

      // Regular paragraphs
      if (line.trim()) {
        // Format inline markdown
        let formatted = this.escapeHtml(line);
        formatted = formatted.replace(/\*\*(.*?)\*\*/g, '<strong class="font-bold">$1</strong>');
        formatted = formatted.replace(/\*(.*?)\*/g, '<em class="italic">$1</em>');
        formatted = formatted.replace(/`([^`]+)`/g, '<code class="bg-gray-200 px-2 py-1 rounded font-mono text-sm">$1</code>');
        
        html += `<p class="text-gray-700 leading-relaxed">${formatted}</p>`;
      }
    }

    // Close any remaining list
    if (inList) {
      html += `<ul class="list-none space-y-2 ml-0"><li class="p-3 bg-gray-100 rounded border-l-4 border-blue-500">${listItems.map(item => `• ${this.escapeHtml(item)}`).join('</li><li class="p-3 bg-gray-100 rounded border-l-4 border-blue-500">')}</li></ul>`;
    }

    return html;
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
}

export default HTMLWrapper;
