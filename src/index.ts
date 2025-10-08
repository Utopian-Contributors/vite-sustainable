import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import type { Plugin, ResolvedConfig } from "vite";

interface SustainablePluginOptions {
  cdnMappingsFile?: string;
  exclude?: string[];
}

interface CDNMapping {
  [packageName: string]: string; // URL template with {version} placeholder
}

export default function sustainable(
  options: SustainablePluginOptions = {}
): Plugin {
  const { cdnMappingsFile = "./cdn-mappings.json", exclude = [] } = options;

  let config: ResolvedConfig;
  const externalDependencies: Record<string, string> = {};
  let cdnMappings: CDNMapping = {};
  const importMap: Record<string, string> = {};
  let isInitialized = false;

  const initializePlugin = async () => {
    if (isInitialized) return;

    try {
      // Read CDN mappings first to know which deps we care about
      const cdnMappingsPath = resolve(
        config.root || process.cwd(),
        cdnMappingsFile
      );
      if (existsSync(cdnMappingsPath)) {
        cdnMappings = JSON.parse(readFileSync(cdnMappingsPath, "utf-8"));
      } else {
        // Create default CDN mappings file
        const defaultMappings: CDNMapping = {
          react: "https://esm.sh/react@{version}",
          "react-dom": "https://esm.sh/react-dom@{version}",
          "react-dom/client": "https://esm.sh/react-dom@{version}/client",
          "framer-motion": "https://esm.sh/framer-motion@{version}",
          "lucide-react": "https://esm.sh/lucide-react@{version}",
          clsx: "https://esm.sh/clsx@{version}",
          "tailwind-merge": "https://esm.sh/tailwind-merge@{version}",
          "class-variance-authority":
            "https://esm.sh/class-variance-authority@{version}",
        };

        // Write default mappings file
        await import("fs/promises").then((fs) =>
          fs.writeFile(
            cdnMappingsPath,
            JSON.stringify(defaultMappings, null, 2)
          )
        );
        cdnMappings = defaultMappings;

        console.log(`📦 Created default CDN mappings file: ${cdnMappingsFile}`);
      }

      // Read package.json for dependencies
      const packageJsonPath = resolve(
        config.root || process.cwd(),
        "package.json"
      );
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

      // Get all top-level dependencies
      const allDependencies = packageJson.dependencies;

      // Only process dependencies that are in CDN mappings and not excluded
      const depsToProcess = Object.keys(cdnMappings).filter(
        (dep) => allDependencies[dep] && !exclude.includes(dep)
      );

      // Read exact versions from lock file - only for deps we care about
      const exactVersions = await getExactVersions(
        config.root || process.cwd(),
        depsToProcess
      );

      // Create external dependencies map with exact versions for CDN-mapped dependencies only
      depsToProcess.forEach((dep) => {
        const exactVersion =
          exactVersions[dep] || allDependencies[dep].replace(/^[\^~]/, "");
        externalDependencies[dep] = exactVersion;
      });

      // Generate import map
      Object.keys(externalDependencies).forEach((dep) => {
        const version = externalDependencies[dep];
        const mapping = cdnMappings[dep];
        if (mapping && version) {
          importMap[dep] = mapping.replace("{version}", version);
        }
      });

      console.log(
        `🌍 Sustainable Plugin: Externalizing ${
          Object.keys(importMap).length
        } dependencies`
      );
      console.log(
        `📋 External dependencies:`,
        Object.keys(importMap).join(", ")
      );

      isInitialized = true;
    } catch (error) {
      console.warn(
        "❌ Sustainable Plugin: Failed to process dependencies:",
        error
      );
    }
  };

  return {
    name: "vite-sustainable-plugin",

    configResolved(resolvedConfig) {
      config = resolvedConfig;
    },

    async buildStart() {
      await initializePlugin();
    },

    async config(viteConfig) {
      // Initialize early to set externals
      if (!config) {
        config = { root: viteConfig.root || process.cwd() } as ResolvedConfig;
      }
      await initializePlugin();

      // Configure externals for build
      if (!viteConfig.build) viteConfig.build = {};
      if (!viteConfig.build.rollupOptions) viteConfig.build.rollupOptions = {};

      // Add external dependencies
      const external = Object.keys(importMap);

      if (external.length > 0) {
        // Handle merging only if existing external is an array of string/RegExp, otherwise assign directly
        const existingExternal = viteConfig.build.rollupOptions.external;
        if (Array.isArray(existingExternal)) {
          viteConfig.build.rollupOptions.external = [
            ...existingExternal,
            ...external,
          ];
        } else if (
          typeof existingExternal === "string" ||
          existingExternal instanceof RegExp
        ) {
          viteConfig.build.rollupOptions.external = [
            existingExternal,
            ...external,
          ];
        } else if (typeof existingExternal === "function") {
          // If it's a function, wrap it to also externalize our dependencies
          const fn = existingExternal;
          viteConfig.build.rollupOptions.external = (
            source: string,
            importer: string | undefined,
            isResolved: boolean
          ) => {
            if (external.includes(source)) return true;
            return fn(source, importer, isResolved);
          };
        } else {
          viteConfig.build.rollupOptions.external = [...external];
        }

        console.log(`🔗 Externalized dependencies: ${external.join(", ")}`);
      }
    },
    transformIndexHtml(html: string) {
      if (Object.keys(importMap).length === 0) {
        return html;
      }

      // Generate import map script
      const importMapScript = `
    <script type="importmap">
      {
        "imports": ${JSON.stringify(importMap, null, 10)}
      }
    </script>`;

      // Insert import map before any module scripts
      const moduleScriptIndex = html.indexOf('<script type="module"');
      if (moduleScriptIndex !== -1) {
        return (
          html.slice(0, moduleScriptIndex) +
          importMapScript +
          "\n     " +
          html.slice(moduleScriptIndex)
        );
      } else {
        // Insert before closing head tag
        return html.replace("</head>", `${importMapScript}\n  </head>`);
      }
    },
  };
}

async function getExactVersions(
  rootPath: string,
  filterDeps?: string[]
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};

  try {
    // Try yarn.lock first
    const yarnLockPath = resolve(rootPath, "yarn.lock");
    if (existsSync(yarnLockPath)) {
      const yarnLock = readFileSync(yarnLockPath, "utf-8");

      // Parse yarn.lock format: "package@version:"
      const yarnMatches = yarnLock.match(
        /^"?([^@\s]+)@[^"]*"?:\s*\n\s*version\s+"([^"]+)"/gm
      );
      if (yarnMatches) {
        yarnMatches.forEach((match) => {
          const [, packageName, version] =
            match.match(/"?([^@\s]+)@[^"]*"?:\s*\n\s*version\s+"([^"]+)"/) ||
            [];
          if (packageName && version) {
            if (filterDeps && filterDeps.includes(packageName)) {
              versions[packageName] = version;
            }
          }
        });
      }
      return versions;
    }

    // Try package-lock.json
    const packageLockPath = resolve(rootPath, "package-lock.json");
    if (existsSync(packageLockPath)) {
      const packageLock = JSON.parse(readFileSync(packageLockPath, "utf-8"));

      if (packageLock.packages) {
        // npm v7+ format
        Object.keys(packageLock.packages).forEach((path) => {
          if (path.startsWith("node_modules/")) {
            const packageName = path.replace("node_modules/", "");
            if (!packageName.includes("/")) {
              // Only top-level packages
              const version = packageLock.packages[path].version;
              if (
                version &&
                (!filterDeps || filterDeps.includes(packageName))
              ) {
                versions[packageName] = version;
              }
            }
          }
        });
      } else if (packageLock.dependencies) {
        // npm v6 format
        Object.keys(packageLock.dependencies).forEach((packageName) => {
          const version = packageLock.dependencies[packageName].version;
          if (version && (!filterDeps || filterDeps.includes(packageName))) {
            versions[packageName] = version;
          }
        });
      }
    }
  } catch (error) {
    console.warn("⚠️ Could not read lock file for exact versions:", error);
  }

  return versions;
}
