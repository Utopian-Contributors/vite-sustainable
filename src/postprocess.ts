import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "fs";
import { join, resolve } from "path";
import semver from "semver";
import type { InlineConfig } from "vite";
import { build as viteBuild } from "vite";
import defaultCdnMappings from "./cdn-mappings.json" with { type: "json" };
import manifestExport from "./manifest.export.json" with { type: "json" };

interface CDNMapping {
  [packageName: string]: string; // URL template with {version} placeholder
}

interface ManifestExport {
  [packageName: string]: string[]; // Array of available versions
}

export interface PostProcessOptions {
  root?: string;
  outDir?: string;
  cdnMappingsPath?: string;
  exclude?: string[];
}

async function getAllLockDependencies(
  rootPath: string,
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};

  try {
    // Try yarn.lock first
    const yarnLockPath = resolve(rootPath, "yarn.lock");
    if (existsSync(yarnLockPath)) {
      const yarnLock = readFileSync(yarnLockPath, "utf-8");

      // Parse yarn.lock format
      const lines = yarnLock.split("\n");
      let currentPackage = "";

      for (const line of lines) {
        // Match package declaration like: "package@version":
        const packageMatch = line.match(/^"?([^@\s]+)@[^"]*"?:$/);
        if (packageMatch && packageMatch[1]) {
          currentPackage = packageMatch[1];
          continue;
        }

        // Match version field
        if (currentPackage && line.trim().startsWith("version")) {
          const versionMatch = line.match(/version\s+"([^"]+)"/);
          if (versionMatch && versionMatch[1]) {
            versions[currentPackage] = versionMatch[1];
            currentPackage = "";
          }
        }
      }
      return versions;
    }

    // Try package-lock.json
    const packageLockPath = resolve(rootPath, "package-lock.json");
    if (existsSync(packageLockPath)) {
      const packageLock = JSON.parse(readFileSync(packageLockPath, "utf-8"));

      if (packageLock.packages) {
        // npm v7+ format - get ALL packages, not just top-level
        Object.keys(packageLock.packages).forEach((path) => {
          if (path.startsWith("node_modules/")) {
            const parts = path.replace("node_modules/", "").split("/");
            const packageName = parts[0];
            if (packageName) {
              const packageData = packageLock.packages[path];
              if (packageData.version && !versions[packageName]) {
                versions[packageName] = packageData.version;
              }
            }
          }
        });
      } else if (packageLock.dependencies) {
        // npm v6 format - recursively get all dependencies
        const extractDeps = (deps: any) => {
          Object.keys(deps).forEach((packageName) => {
            const dep = deps[packageName];
            if (dep.version) {
              versions[packageName] = dep.version;
            }
            if (dep.dependencies) {
              extractDeps(dep.dependencies);
            }
          });
        };
        extractDeps(packageLock.dependencies);
      }
    }
  } catch (error) {
    console.warn("⚠️ Could not read lock file for exact versions:", error);
  }

  return versions;
}

/**
 * Finds the closest available version from the manifest using semver
 * Prefers the exact match or the highest version that's <= requested version
 * Falls back to the lowest available version if requested version is lower than all available
 */
function findClosestVersion(
  requestedVersion: string,
  availableVersions: string[],
): string | null {
  if (availableVersions.length === 0) return null;

  // Clean and validate versions
  const cleanRequested = semver.clean(requestedVersion);
  if (!cleanRequested) {
    console.warn(`  ⚠️  Invalid requested version: ${requestedVersion}`);
    return availableVersions[0] || null; // Return first available as fallback
  }

  // Check for exact match first
  if (availableVersions.includes(requestedVersion)) {
    return requestedVersion;
  }

  // Filter and sort available versions in descending order
  const validVersions = availableVersions
    .filter((v) => semver.valid(v))
    .sort((a, b) => semver.rcompare(a, b)); // rcompare sorts descending

  if (validVersions.length === 0) {
    console.warn(`  ⚠️  No valid semver versions available`);
    return availableVersions[0] || null; // Return first available as fallback
  }

  // Find the highest version that's <= requested version
  for (const version of validVersions) {
    if (semver.lte(version, cleanRequested)) {
      return version;
    }
  }

  // If requested version is lower than all available, use the lowest available
  return validVersions[validVersions.length - 1] || null;
}

/**
 * Maps lock file versions to the closest available versions from the manifest
 */
function mapToAvailableVersions(
  lockDependencies: Record<string, string>,
  manifest: ManifestExport,
): Record<string, string> {
  const mappedVersions: Record<string, string> = {};

  Object.keys(lockDependencies).forEach((packageName) => {
    const requestedVersion = lockDependencies[packageName];
    if (!requestedVersion) return;

    const availableVersions = manifest[packageName];

    if (availableVersions && availableVersions.length > 0) {
      const closestVersion = findClosestVersion(
        requestedVersion,
        availableVersions,
      );
      if (closestVersion) {
        mappedVersions[packageName] = closestVersion;
        if (closestVersion !== requestedVersion) {
          console.log(
            `  📦 ${packageName}: ${requestedVersion} → ${closestVersion} (closest available)`,
          );
        } else {
          console.log(`  ✓ ${packageName}: ${requestedVersion} (exact match)`);
        }
      } else {
        // No suitable version found
        throw new Error(
          `  ⚠️  ${packageName}: No suitable version found in manifest, you will need to exclude it manually from being processed.`,
        );
      }
    } else {
      // Package not in manifest, use requested version
      throw new Error(
        `  ⚠️  ${packageName}: The requested package is not available in the manifest, you will need to exclude it manually from being processed.`,
      );
    }
  });

  return mappedVersions;
}

export async function createDualBuild(options: PostProcessOptions = {}) {
  const {
    root = process.cwd(),
    outDir = "dist",
    cdnMappingsPath,
    exclude = [],
  } = options;

  const rootDir = resolve(root);
  const outputDir = resolve(rootDir, outDir);
  const miniDir = resolve(outputDir, "mini");

  console.log("🚀 Starting sustainable post-processing...");

  try {
    // Read CDN mappings
    let cdnMappings: CDNMapping = defaultCdnMappings;

    if (cdnMappingsPath) {
      const mappingsPath = resolve(rootDir, cdnMappingsPath);
      if (existsSync(mappingsPath)) {
        const customMappings = JSON.parse(readFileSync(mappingsPath, "utf-8"));

        // Validate that all CDN mappings use esm.sh
        const invalidMappings: string[] = [];
        Object.entries(customMappings).forEach(([packageName, url]) => {
          if (typeof url === "string" && !url.includes("esm.sh")) {
            invalidMappings.push(`${packageName}: ${url}`);
          }
        });

        if (invalidMappings.length > 0) {
          console.error("❌ Custom CDN mappings contain non-esm.sh URLs:");
          invalidMappings.forEach((mapping) => {
            console.error(`   ${mapping}`);
          });
          console.error("\n⚠️  Currently, only esm.sh CDN is supported.");
          console.error(
            "   Please update your cdn-mappings.json to use esm.sh URLs.",
          );
          console.error("   Example: https://esm.sh/package-name@{version}");
          throw new Error("Invalid CDN mappings");
        }

        cdnMappings = customMappings;
        console.log(`✅ Loaded custom CDN mappings from ${mappingsPath}`);
      }
    }

    console.log(
      `📋 CDN mappings available for ${Object.keys(cdnMappings).length} packages`,
    );

    // Get all dependencies from lock file
    const allLockDependencies = await getAllLockDependencies(rootDir);

    console.log(
      `📦 Found ${Object.keys(allLockDependencies).length} dependencies in lock file`,
    );

    // Filter dependencies to externalize based on CDN mappings
    const depsToExternalize = Object.keys(cdnMappings).filter(
      (dep) => allLockDependencies[dep] && !exclude.includes(dep),
    );

    console.log(
      `🎯 Found ${depsToExternalize.length} dependencies that match CDN mappings`,
    );

    if (depsToExternalize.length === 0) {
      console.log("ℹ️ No dependencies to externalize");
      return;
    }

    // Get lock file versions for dependencies to externalize
    const depsWithVersions: Record<string, string> = {};
    depsToExternalize.forEach((dep) => {
      const version = allLockDependencies[dep];
      if (version) {
        depsWithVersions[dep] = version;
      }
    });

    // Map to available versions from manifest
    console.log("🔍 Mapping to available versions from browser extension...");
    const availableVersions = mapToAvailableVersions(
      depsWithVersions,
      manifestExport as ManifestExport,
    );

    console.log(
      `✅ Successfully mapped ${Object.keys(availableVersions).length} dependencies to available versions`,
    );

    if (depsToExternalize.length === 0) {
      console.log("ℹ️ No dependencies to externalize");
      return;
    }

    // Generate import map using available versions
    const importMap: Record<string, string> = {};
    depsToExternalize.forEach((dep) => {
      const version = availableVersions[dep];
      const cdnUrl = cdnMappings[dep];
      if (cdnUrl && version) {
        importMap[dep] = cdnUrl.replace("{version}", version);
      }
    });

    console.log("📦 Generated import map:", importMap);

    // Check if build exists
    if (!existsSync(outputDir)) {
      console.error("❌ No build found at", outputDir);
      console.error("   Please run 'vite build' first before post-processing");
      return;
    }

    // Read existing build files
    const standardIndexPath = join(outputDir, "index.html");
    let standardHtml = "";
    let standardScriptPath = "";
    let standardStylePath = "";

    if (existsSync(standardIndexPath)) {
      standardHtml = readFileSync(standardIndexPath, "utf-8");

      // Extract script and style paths
      const scriptMatch = standardHtml.match(
        /<script type="module" crossorigin src="(\/assets\/[^"]+)">/,
      );
      const styleMatch = standardHtml.match(
        /<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/,
      );

      standardScriptPath = scriptMatch?.[1] || "";
      standardStylePath = styleMatch?.[1] || "";
    } else {
      console.error("❌ No index.html found in build directory");
      return;
    }

    // Setup for mini build
    const viteConfigPath = resolve(rootDir, "vite.config.ts");
    const configFileExists = existsSync(viteConfigPath);

    // Run mini build with externalized dependencies
    console.log("🔨 Building mini version with externalized dependencies...");

    const miniBuildConfig: InlineConfig = {
      root: rootDir,
      mode: "production",
      build: {
        outDir: miniDir,
        emptyOutDir: true,
        copyPublicDir: false,
        rollupOptions: {
          external: depsToExternalize,
          output: {
            format: "es",
            entryFileNames: "assets/index-[hash].js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash].[ext]",
          },
        },
      },
      configFile: configFileExists ? viteConfigPath : false,
    };

    await viteBuild(miniBuildConfig);
    console.log("✅ Mini build completed");

    // Get mini build file paths
    let miniScriptPath = "";

    const miniIndexPath = join(miniDir, "index.html");
    console.log(`🔍 Looking for mini index.html at: ${miniIndexPath}`);

    if (existsSync(miniIndexPath)) {
      const miniHtml = readFileSync(miniIndexPath, "utf-8");
      console.log(`📄 Mini index.html found, length: ${miniHtml.length} chars`);

      // Extract script and style paths from mini build
      const miniScriptMatch = miniHtml.match(
        /<script type="module" crossorigin src="(\/[^"]+)">/,
      );

      if (miniScriptMatch?.[1]) {
        // Convert to relative path from mini directory
        miniScriptPath = miniScriptMatch[1].replace("/assets/", "/mini/");
        console.log(`📄 Found mini script path: ${miniScriptPath}`);
      } else {
        console.error("❌ Could not find script path in mini build index.html");
        console.error("Mini HTML content:", miniHtml.substring(0, 500) + "...");
        throw new Error("Could not find script path in mini build index.html");
      }
    }

    // Move mini assets to dist/mini
    const miniAssetsDir = join(miniDir, "assets");
    const targetMiniDir = join(outputDir, "mini");

    console.log(`🔍 Looking for mini assets at: ${miniAssetsDir}`);

    if (existsSync(miniAssetsDir)) {
      const assetFiles = readdirSync(miniAssetsDir);
      console.log(`📦 Found ${assetFiles.length} asset files in mini build`);

      mkdirSync(targetMiniDir, { recursive: true });

      // Move only the asset files, not the HTML
      assetFiles.forEach((file) => {
        console.log(`  📄 Moving: ${file}`);
        cpSync(join(miniAssetsDir, file), join(targetMiniDir, file));
      });
    } else {
      console.warn(`⚠️  No assets directory found at: ${miniAssetsDir}`);
    }

    // Create the unified index.html with conditional loading
    const unifiedHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/logo.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${getTitle(standardHtml)}</title>

    <script type="importmap">
      {
        "imports": ${JSON.stringify(importMap, null, 10)}
      }
    </script>

    <script type="module">
      await Promise.resolve(
        setTimeout(async () => {
          if (window.__SUSTAINABLE_BUILD__) {
            await import("${miniScriptPath}");
          } else {
            await import("${standardScriptPath}");
          }
        }, 10)
      );
    </script>
    <link rel="stylesheet" crossorigin href="${standardStylePath}" />
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

    // Write the unified HTML
    writeFileSync(standardIndexPath, unifiedHtml);
    console.log("📝 Updated index.html with conditional loading");

    // Clean up the mini build's separate files
    if (existsSync(miniIndexPath)) {
      rmSync(miniIndexPath);
    }
    if (existsSync(miniAssetsDir)) {
      rmSync(miniAssetsDir, { recursive: true });
    }

    console.log(`
🎉 Sustainable post-processing complete!
   
   Build structure:
   ${outputDir}/
   ├── index.html (updated with conditional loading)
   ├── index.original.html (backup of original)
   ├── assets/ (standard build)
   └── mini/ (externalized dependencies)
   
   The build will use:
   - Standard build when window.__SUSTAINABLE_BUILD__ is true
   - Mini build (with CDN dependencies) otherwise
`);
  } catch (error) {
    console.error("❌ Error during post-processing:", error);
    throw error;
  }
}

function getTitle(html: string): string {
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  return titleMatch?.[1] || "Vite App";
}

// Allow running as a CLI script
if (import.meta.url === `file://${process.argv[1]}`) {
  createDualBuild().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
