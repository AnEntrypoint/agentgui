// Plugin loader - manages registry, dependencies, hot reload, error isolation

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

class PluginLoader extends EventEmitter {
  constructor(pluginDir) {
    super();
    this.pluginDir = pluginDir;
    this.registry = new Map(); // name => plugin module
    this.instances = new Map(); // name => initialized plugin state
    this.states = new Map(); // name => { routes, wsHandlers, api, ... }
    this.watchers = new Map(); // name => file watcher
    this.errorCounts = new Map(); // name => { count, firstTime }
  }

  // Load plugin module from disk
  async loadPlugin(name) {
    const filePath = path.join(this.pluginDir, `${name}.js`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Plugin file not found: ${filePath}`);
    }
    // Clear module cache for hot reload (ES modules use import cache differently)
    const fileUrl = `file://${filePath}?v=${Date.now()}`;
    try {
      const plugin = await import(fileUrl);
      this.registry.set(name, plugin.default || plugin);
      return plugin.default || plugin;
    } catch (error) {
      console.error(`Failed to load plugin ${name}:`, error.message);
      throw error;
    }
  }

  // Initialize plugin and all dependencies
  async initializePlugin(name, config) {
    const plugin = this.registry.get(name);
    if (!plugin) {
      throw new Error(`Plugin ${name} not found in registry`);
    }

    // Check if already initialized
    if (this.instances.has(name)) {
      return this.instances.get(name);
    }

    // Initialize dependencies first
    for (const depName of (plugin.dependencies || [])) {
      if (!this.instances.has(depName)) {
        await this.initializePlugin(depName, config);
      }
    }

    // Initialize this plugin
    try {
      const result = await plugin.init(config, this.instances);
      this.instances.set(name, result);
      return result;
    } catch (error) {
      console.error(`[PluginLoader] Error initializing ${name}:`, error.message);
      throw error;
    }
  }

  // Get initialized plugin result
  get(name) {
    return this.instances.get(name);
  }

  // Hot reload a plugin
  async reloadPlugin(name) {
    const plugin = this.registry.get(name);
    if (!plugin) {
      console.warn(`[PluginLoader] Cannot reload ${name}: not found`);
      return;
    }

    const state = this.instances.get(name);
    if (!state) {
      console.warn(`[PluginLoader] Cannot reload ${name}: not initialized`);
      return;
    }

    try {
      // Stop old instance
      if (state.stop) await state.stop();

      // Reload plugin module
      this.loadPlugin(name);
      const reloadedPlugin = this.registry.get(name);

      // Reinitialize with preserved state
      const newState = await reloadedPlugin.reload(state);
      this.instances.set(name, newState);
      this.emit('reload', { name, success: true });
      console.log(`[PluginLoader] Reloaded plugin: ${name}`);
    } catch (error) {
      console.error(`[PluginLoader] Error reloading ${name}:`, error.message);
      this.emit('reload', { name, success: false, error: error.message });
    }
  }

  // Watch a plugin file for changes
  watchPlugin(name, callback) {
    const filePath = path.join(this.pluginDir, `${name}.js`);
    if (this.watchers.has(name)) {
      return; // Already watching
    }

    const watcher = fs.watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        setTimeout(() => callback(name), 100); // Debounce
      }
    });

    this.watchers.set(name, watcher);
  }

  // Stop watching a plugin
  unwatchPlugin(name) {
    const watcher = this.watchers.get(name);
    if (watcher) {
      watcher.close();
      this.watchers.delete(name);
    }
  }

  // Load all plugins from directory
  async loadAllPlugins(config) {
    if (!fs.existsSync(this.pluginDir)) {
      fs.mkdirSync(this.pluginDir, { recursive: true });
      return;
    }

    const files = fs.readdirSync(this.pluginDir).filter(f => f.endsWith('.js'));
    for (const file of files) {
      const name = file.replace('.js', '');
      try {
        await this.loadPlugin(name);
      } catch (error) {
        console.error(`[PluginLoader] Failed to load ${name}:`, error.message);
      }
    }

    // Initialize in dependency order
    const sorted = this.topologicalSort();
    for (const name of sorted) {
      try {
        await this.initializePlugin(name, config);
      } catch (error) {
        console.error(`[PluginLoader] Failed to initialize ${name}:`, error.message);
      }
    }
  }

  // Topological sort by dependencies
  topologicalSort() {
    const visited = new Set();
    const result = [];

    const visit = (name) => {
      if (visited.has(name)) return;
      visited.add(name);

      const plugin = this.registry.get(name);
      for (const dep of (plugin?.dependencies || [])) {
        if (this.registry.has(dep)) {
          visit(dep);
        }
      }
      result.push(name);
    };

    for (const name of this.registry.keys()) {
      visit(name);
    }

    return result;
  }

  // Graceful shutdown
  async shutdown() {
    const sorted = this.topologicalSort().reverse();
    for (const name of sorted) {
      const state = this.instances.get(name);
      if (state && state.stop) {
        try {
          await state.stop();
        } catch (error) {
          console.error(`[PluginLoader] Error stopping ${name}:`, error.message);
        }
      }
      this.unwatchPlugin(name);
    }
    this.instances.clear();
    this.registry.clear();
  }
}
export default PluginLoader;
