import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const EXTENSION_PATH = resolve(process.cwd(), 'extensions', 'squad-reviews', 'extension.mjs');

function loadRegisteredTools() {
  const script = `
    import { readFileSync } from 'node:fs';
    import vm from 'node:vm';
    import { dirname, resolve as resolvePath } from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';

    const extensionPath = process.argv[1];
    const context = vm.createContext({
      console,
      process,
      setTimeout,
      clearTimeout,
      URL,
      fetch,
      Headers,
      Request,
      Response,
    });
    const cache = new Map();
    let capturedTools = null;

    async function createNamespaceModule(specifier) {
      if (cache.has(specifier)) {
        return await cache.get(specifier);
      }

      const modulePromise = (async () => {
        const namespace = await import(specifier);
        const exportNames = Object.keys(namespace);
        const module = new vm.SyntheticModule(exportNames, function () {
          for (const name of exportNames) {
            this.setExport(name, namespace[name]);
          }
        }, { context, identifier: specifier });

        await module.link(() => {
          throw new Error('Synthetic node modules should not import dependencies');
        });
        return module;
      })();

      cache.set(specifier, modulePromise);
      return await modulePromise;
    }

    async function loadModule(modulePath) {
      const identifier = pathToFileURL(modulePath).href;
      if (cache.has(identifier)) {
        return await cache.get(identifier);
      }

      const modulePromise = (async () => {
        const source = readFileSync(modulePath, 'utf8');
        const module = new vm.SourceTextModule(source, {
          context,
          identifier,
          initializeImportMeta(meta) {
            meta.url = identifier;
          },
        });

          await module.link(async (specifier, referencingModule) => {
          if (specifier === '@github/copilot-sdk/extension') {
            const module = new vm.SyntheticModule(['joinSession'], function () {
              this.setExport('joinSession', async ({ tools } = {}) => {
                capturedTools = tools;
                return {};
              });
            }, { context, identifier: specifier });
            await module.link(() => {
              throw new Error('Mocked copilot-sdk module should not import dependencies');
            });
            return module;
          }

          if (specifier.startsWith('node:')) {
            return createNamespaceModule(specifier);
          }

          if (specifier.startsWith('./') || specifier.startsWith('../')) {
            const parentPath = fileURLToPath(referencingModule.identifier);
            const resolvedPath = resolvePath(dirname(parentPath), specifier);
            return loadModule(resolvedPath);
          }

          throw new Error('Unexpected import: ' + specifier);
        });

        return module;
      })();

      cache.set(identifier, modulePromise);
      return await modulePromise;
    }

    const module = await loadModule(extensionPath);
    await module.evaluate();

    if (!Array.isArray(capturedTools)) {
      throw new Error('Failed to capture tools array from joinSession');
    }

    const summary = capturedTools.map((tool) => ({
      name: tool?.name,
      description: tool?.description,
      skipPermission: tool?.skipPermission,
      parameters: tool?.parameters,
      handlerType: typeof tool?.handler,
    }));

    console.log(JSON.stringify(summary));
  `;

  const stdout = execFileSync('node', ['--experimental-vm-modules', '--input-type=module', '-e', script, EXTENSION_PATH], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  return JSON.parse(stdout);
}

test('extension registers squad review tools with allow-all permissions and valid shapes', () => {
  const tools = loadRegisteredTools();
  const names = tools.map((tool) => tool.name);

  assert.ok(tools.length >= 1, `Expected at least 1 tool, got ${tools.length}`);
  assert.equal(new Set(names).size, names.length, 'Expected tool names to be unique');

  for (const tool of tools) {
    assert.match(tool.name, /^squad_reviews_/, `Expected tool name to start with squad_reviews_: ${tool.name}`);
    assert.equal(typeof tool.description, 'string', `Expected ${tool.name} to have a string description`);
    assert.notEqual(tool.description.trim(), '', `Expected ${tool.name} to have a non-empty description`);
    assert.equal(tool.skipPermission, true, `Expected ${tool.name} to skip permission checks`);
    assert.equal(tool.parameters?.type, 'object', `Expected ${tool.name} parameters.type to be object`);
    assert.equal(typeof tool.parameters?.properties, 'object', `Expected ${tool.name} parameters.properties to be an object`);
    assert.notEqual(tool.parameters?.properties, null, `Expected ${tool.name} parameters.properties to be non-null`);
    assert.ok(Array.isArray(tool.parameters?.required), `Expected ${tool.name} parameters.required to be an array`);
    assert.equal(tool.handlerType, 'function', `Expected ${tool.name} handler to be a function`);
  }
});
