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
import type { InlineConfig } from "vite";
import { build as viteBuild } from "vite";
import defaultCdnMappings from "./cdn-mappings.json" with { type: "json" };

interface CDNMapping {
  [packageName: string]: string; // URL template with {version} placeholder
}

export interface PostProcessOptions {
  root?: string;
  outDir?: string;
  cdnMappingsPath?: string;
  exclude?: string[];
}

async function getAllLockDependencies(
  rootPath: string
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};

  try {
    // Try yarn.lock first
    const yarnLockPath = resolve(rootPath, "yarn.lock");
    if (existsSync(yarnLockPath)) {
      const yarnLock = readFileSync(yarnLockPath, "utf-8");

      // Parse yarn.lock format
      const lines = yarnLock.split('\n');
      let currentPackage = '';
      
      for (const line of lines) {
        // Match package declaration like: "package@version":
        const packageMatch = line.match(/^"?([^@\s]+)@[^"]*"?:$/);
        if (packageMatch && packageMatch[1]) {
          currentPackage = packageMatch[1];
          continue;
        }
        
        // Match version field
        if (currentPackage && line.trim().startsWith('version')) {
          const versionMatch = line.match(/version\s+"([^"]+)"/);
          if (versionMatch && versionMatch[1]) {
            versions[currentPackage] = versionMatch[1];
            currentPackage = '';
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
            const parts = path.replace("node_modules/", "").split('/');
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

export async function createDualBuild(options: PostProcessOptions = {}) {
  const {
    root = process.cwd(),
    outDir = "dist",
    cdnMappingsPath,
    exclude = [],
  } = options;

  const rootDir = resolve(root);
  const outputDir = resolve(rootDir, outDir);
  const tempDir = resolve(rootDir, ".sustainable-temp");
  const miniDir = resolve(outputDir, "mini");

  console.log("🚀 Starting sustainable post-processing...");

  try {
    // Step 1: Read CDN mappings
    let cdnMappings: CDNMapping = defaultCdnMappings;
    
    if (cdnMappingsPath) {
      const mappingsPath = resolve(rootDir, cdnMappingsPath);
      if (existsSync(mappingsPath)) {
        cdnMappings = JSON.parse(readFileSync(mappingsPath, "utf-8"));
        console.log(`✅ Loaded custom CDN mappings from ${mappingsPath}`);
      }
    }

    console.log(
      `📋 CDN mappings available for ${Object.keys(cdnMappings).length} packages`
    );

    // Step 2: Get all dependencies from lock file
    const allLockDependencies = await getAllLockDependencies(rootDir);

    // Step 3: Filter dependencies to externalize
    const depsToExternalize = Object.keys(cdnMappings).filter(
      (dep) => allLockDependencies[dep] && !exclude.includes(dep)
    );

    console.log(
      `📦 Found ${Object.keys(allLockDependencies).length} dependencies in lock file`
    );
    console.log(
      `🎯 Will externalize ${depsToExternalize.length} dependencies that match CDN mappings`
    );

    if (depsToExternalize.length === 0) {
      console.log("ℹ️ No dependencies to externalize");
      return;
    }

    // Step 4: Generate import map
    const importMap: Record<string, string> = {};
    depsToExternalize.forEach((dep) => {
      const version = allLockDependencies[dep];
      const cdnUrl = cdnMappings[dep];
      if (cdnUrl && version) {
        importMap[dep] = cdnUrl.replace("{version}", version);
      }
    });

    console.log("📦 Generated import map:", importMap);

    // Step 5: Save current build to temp
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
    if (existsSync(outputDir)) {
      cpSync(outputDir, tempDir, { recursive: true });
      console.log("💾 Saved current build to temp directory");
    }

    // Step 6: Clear output directory
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true });
    }
    mkdirSync(outputDir, { recursive: true });

    // Step 7: Run normal build first
    console.log("🔨 Building standard version...");
    
    const viteConfigPath = resolve(rootDir, "vite.config.ts");
    const configFileExists = existsSync(viteConfigPath);

    const normalBuildConfig: InlineConfig = {
      root: rootDir,
      mode: "production",
      build: {
        outDir: outputDir,
        emptyOutDir: true,
      },
      configFile: configFileExists ? viteConfigPath : false,
    };

    await viteBuild(normalBuildConfig);
    console.log("✅ Standard build completed");

    // Step 8: Save standard build files
    const standardIndexPath = join(outputDir, "index.html");
    let standardHtml = "";
    let standardScriptPath = "";
    let standardStylePath = "";

    if (existsSync(standardIndexPath)) {
      standardHtml = readFileSync(standardIndexPath, "utf-8");
      
      // Extract script and style paths
      const scriptMatch = standardHtml.match(/<script type="module" crossorigin src="(\/assets\/[^"]+)">/);
      const styleMatch = standardHtml.match(/<link rel="stylesheet" crossorigin href="(\/assets\/[^"]+)">/);
      
      standardScriptPath = scriptMatch?.[1] || "";
      standardStylePath = styleMatch?.[1] || "";
    }

    // Step 9: Run mini build with externalized dependencies
    console.log("🔨 Building mini version with externalized dependencies...");

    const miniBuildConfig: InlineConfig = {
      root: rootDir,
      mode: "production",
      build: {
        outDir: miniDir,
        emptyOutDir: true,
        rollupOptions: {
          external: depsToExternalize,
          output: {
            format: "es",
            entryFileNames: "index-[hash].js",
            chunkFileNames: "[name]-[hash].js",
            assetFileNames: "[name]-[hash].[ext]",
          },
        },
      },
      configFile: configFileExists ? viteConfigPath : false,
    };

    await viteBuild(miniBuildConfig);
    console.log("✅ Mini build completed");

    // Step 10: Get mini build file paths
    let miniScriptPath = "";
    
    const miniIndexPath = join(miniDir, "index.html");
    if (existsSync(miniIndexPath)) {
      const miniHtml = readFileSync(miniIndexPath, "utf-8");
      
      // Extract script and style paths from mini build
      const miniScriptMatch = miniHtml.match(/<script type="module" crossorigin src="(\/assets\/[^"]+)">/);
      
      if (miniScriptMatch?.[1]) {
        // Convert to relative path from mini directory
        miniScriptPath = miniScriptMatch[1].replace("/assets/", "/mini/");
      }
    }

    // Step 11: Move mini assets to dist/mini
    const miniAssetsDir = join(miniDir, "assets");
    const targetMiniDir = join(outputDir, "mini");
    
    if (existsSync(miniAssetsDir)) {
      mkdirSync(targetMiniDir, { recursive: true });
      
      // Move only the asset files, not the HTML
      readdirSync(miniAssetsDir).forEach(file => {
        cpSync(join(miniAssetsDir, file), join(targetMiniDir, file));
      });
    }

    // Step 12: Create the unified index.html with conditional loading
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
            await import("${standardScriptPath}");
          } else {
            await import("${miniScriptPath}");
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
    console.log("📝 Created unified index.html with conditional loading");

    // Step 13: Clean up temp directory
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }

    // Step 14: Clean up the mini build's separate files
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
   ├── index.html (with conditional loading)
   ├── assets/ (standard build)
   └── mini/ (externalized dependencies)
   
   The build will use:
   - Standard build when window.__SUSTAINABLE_BUILD__ is true
   - Mini build (with CDN dependencies) otherwise
`);

  } catch (error) {
    console.error("❌ Error during post-processing:", error);

    // Try to restore the original build if something went wrong
    if (existsSync(tempDir) && !existsSync(outputDir)) {
      console.log("🔄 Attempting to restore original build...");
      cpSync(tempDir, outputDir, { recursive: true });
      rmSync(tempDir, { recursive: true });
      console.log("✅ Original build restored");
    }

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