const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const multer = require("multer");
const AdmZip = require("adm-zip");
const { v4: uuidv4 } = require("uuid");
const { execFile } = require("child_process");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 4000;

const WORKSPACE_DIR = path.join(__dirname, "workspace");
const HISTORY_FILE = path.join(__dirname, "build-history.json");

fs.ensureDirSync(WORKSPACE_DIR);
if (!fs.existsSync(HISTORY_FILE)) fs.writeJsonSync(HISTORY_FILE, []);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: path.join(WORKSPACE_DIR, "_uploads"),
  limits: { fileSize: 150 * 1024 * 1024 }, // 150MB, matches typical project zip sizes
});

// ---------- local build history (no tokens ever stored here) ----------

function readHistory() {
  try {
    return fs.readJsonSync(HISTORY_FILE);
  } catch (e) {
    return [];
  }
}

function appendHistory(record) {
  const history = readHistory();
  history.unshift(record); // newest first
  fs.writeJsonSync(HISTORY_FILE, history.slice(0, 200)); // keep last 200
}

app.get("/api/history", (req, res) => {
  res.json(readHistory());
});

// ---------- helpers ----------

// Resolve eas-cli's binary from THIS app's node_modules, not the uploaded
// project's folder. npx would look relative to `cwd` (the extracted user
// project) and fail to find it there, even though it's installed here.
const EAS_BIN = path.join(__dirname, "node_modules", ".bin", "eas");

function runCli(args, cwd, token) {
  return new Promise((resolve, reject) => {
    execFile(
      EAS_BIN,
      [...args],
      {
        cwd,
        // EXPO_DEBUG surfaces the actual underlying error instead of eas-cli's
        // generic "X command failed" wrapper message.
        env: { ...process.env, EXPO_TOKEN: token, CI: "1", EXPO_DEBUG: "1" },
        maxBuffer: 1024 * 1024 * 20,
        timeout: 5 * 60 * 1000, // eas build --no-wait should return fast; 5 min safety net
      },
      (error, stdout, stderr) => {
        if (error) {
          // Keep both streams — eas-cli sometimes puts the real cause on
          // stdout and only a generic wrapper message on stderr, or vice
          // versa. Dropping either one hides the actual reason.
          const combined = [stdout, stderr].filter(Boolean).join("\n---\n");
          reject(new Error(combined || error.message));
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

function extractJson(stdout) {
  // eas-cli sometimes prints npx/update-check noise before the JSON payload.
  const firstBracket = Math.min(
    ...["[", "{"]
      .map((c) => stdout.indexOf(c))
      .filter((i) => i !== -1)
  );
  if (!isFinite(firstBracket)) throw new Error("No JSON found in eas-cli output:\n" + stdout);
  const jsonSlice = stdout.slice(firstBracket);
  return JSON.parse(jsonSlice);
}

async function ensureEasJson(projectDir) {
  const easPath = path.join(projectDir, "eas.json");
  let easJson = { cli: {}, build: {}, submit: { production: {} } };
  if (await fs.pathExists(easPath)) {
    try {
      easJson = await fs.readJson(easPath);
    } catch (e) {
      // fall back to a fresh config if the existing one is malformed
    }
  }
  easJson.build = easJson.build || {};
  // Dedicated profile so we never clash with a profile the project already defines.
  easJson.build.apkforge = {
    android: { buildType: "apk" },
    distribution: "internal",
  };
  await fs.writeJson(easPath, easJson, { spaces: 2 });
}

async function patchOwner(projectDir, owner) {
  if (!owner) return;
  const appJsonPath = path.join(projectDir, "app.json");
  if (!(await fs.pathExists(appJsonPath))) return;
  const appJson = await fs.readJson(appJsonPath);
  appJson.expo = appJson.expo || {};
  appJson.expo.owner = owner;
  await fs.writeJson(appJsonPath, appJson, { spaces: 2 });
}

function parseWhoamiOutput(stdout) {
  // eas-cli sometimes prints update-check noise ("eas-cli@X is now
  // available...") above the actual answer, so take the last non-empty line.
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

async function patchPackageName(projectDir, packageName) {
  if (!packageName) return;
  const appJsonPath = path.join(projectDir, "app.json");
  if (!(await fs.pathExists(appJsonPath))) return;
  const appJson = await fs.readJson(appJsonPath);
  appJson.expo = appJson.expo || {};
  appJson.expo.android = appJson.expo.android || {};
  appJson.expo.android.package = packageName;
  await fs.writeJson(appJsonPath, appJson, { spaces: 2 });
}

async function patchProjectId(projectDir, projectId) {
  if (!projectId) return;
  const appJsonPath = path.join(projectDir, "app.json");
  if (!(await fs.pathExists(appJsonPath))) return;
  const appJson = await fs.readJson(appJsonPath);
  appJson.expo = appJson.expo || {};
  appJson.expo.extra = appJson.expo.extra || {};
  appJson.expo.extra.eas = appJson.expo.extra.eas || {};
  appJson.expo.extra.eas.projectId = projectId;
  await fs.writeJson(appJsonPath, appJson, { spaces: 2 });
}

function findProjectRoot(dir) {
  // Handles zips where everything sits inside one wrapper folder,
  // e.g. my-project/package.json instead of package.json at the zip root.
  const entries = fs.readdirSync(dir);
  if (entries.includes("package.json")) return dir;
  const subdirs = entries.filter((e) => fs.statSync(path.join(dir, e)).isDirectory());
  for (const sub of subdirs) {
    const candidate = path.join(dir, sub);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
  }
  return dir;
}

// ---------- main build endpoint ----------

app.post("/api/build", upload.single("projectZip"), async (req, res) => {
  const { expoToken, packageName, projectId } = req.body;
  const uploadedZip = req.file;

  if (!expoToken) {
    return res.status(400).json({ error: "Missing Expo access token." });
  }
  if (!uploadedZip) {
    return res.status(400).json({ error: "Missing project ZIP file." });
  }

  const buildLocalId = uuidv4();
  const extractDir = path.join(WORKSPACE_DIR, buildLocalId);

  try {
    await fs.ensureDir(extractDir);
    const zip = new AdmZip(uploadedZip.path);
    zip.extractAllTo(extractDir, true);
    await fs.remove(uploadedZip.path);

    const projectDir = findProjectRoot(extractDir);
    const packageJsonPath = path.join(projectDir, "package.json");

    if (!(await fs.pathExists(packageJsonPath))) {
      throw new Error(
        "No package.json found. This build service only supports Expo projects, not native Java/Kotlin zips."
      );
    }
    const packageJson = await fs.readJson(packageJsonPath);
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (!deps.expo) {
      throw new Error(
        "package.json doesn't list 'expo' as a dependency. This build service only supports Expo projects."
      );
    }

    await patchPackageName(projectDir, packageName);
    await ensureEasJson(projectDir);

    // Confirm the token actually works before we burn a build slot on a typo,
    // and capture the account name — personal access tokens are treated as
    // "robot tokens" by EAS, which require an explicit `expo.owner` in
    // app.json or the build fails with an ownership-mismatch error.
    const whoamiOut = await runCli(["whoami"], projectDir, expoToken);
    const owner = parseWhoamiOutput(whoamiOut);
    await patchOwner(projectDir, owner);

    if (projectId) {
      // Attach directly to a project you already created on expo.dev.
      // Personal access tokens on team accounts often can't CREATE new
      // projects (even as Admin), so we skip `eas init`'s create step
      // entirely here instead of hitting that permission wall.
      await patchProjectId(projectDir, projectId);
    } else {
      // Fall back to letting eas-cli create/link a project automatically.
      // This works fine for personal (non-team) accounts; team accounts may
      // hit a permissions error here — if so, create a project manually on
      // expo.dev and pass its ID in instead.
      let initError = null;
      try {
        await runCli(["init", "--non-interactive"], projectDir, expoToken);
      } catch (e1) {
        initError = e1;
        try {
          await runCli(["init", "--non-interactive", "--force"], projectDir, expoToken);
          initError = null;
        } catch (e2) {
          initError = e2;
        }
      }
      if (initError) {
        throw new Error("eas init failed: " + initError.message);
      }
    }

    const stdout = await runCli(
      [
        "build",
        "--platform",
        "android",
        "--profile",
        "apkforge",
        "--non-interactive",
        "--no-wait",
        "--json",
      ],
      projectDir,
      expoToken
    );

    const parsed = extractJson(stdout);
    const buildInfo = Array.isArray(parsed) ? parsed[0] : parsed;
    const expoBuildId = buildInfo.id;
    const pageUrl = buildInfo.buildDetailsPageUrl || buildInfo.buildUrl || null;

    const record = {
      id: buildLocalId,
      expoBuildId,
      pageUrl,
      filename: uploadedZip.originalname,
      packageName: packageName || null,
      status: "in-queue",
      createdAt: new Date().toISOString(),
    };
    appendHistory(record);

    res.json(record);
  } catch (err) {
    const record = {
      id: buildLocalId,
      expoBuildId: null,
      pageUrl: null,
      filename: uploadedZip ? uploadedZip.originalname : "unknown.zip",
      packageName: packageName || null,
      status: "error",
      error: err.message.slice(0, 4000),
      createdAt: new Date().toISOString(),
    };
    appendHistory(record);
    res.status(500).json(record);
  } finally {
    // The source has already been uploaded to EAS's build servers by the CLI
    // itself, so we don't need to keep a local copy around.
    fs.remove(extractDir).catch(() => {});
  }
});

// ---------- status polling ----------

app.get("/api/build/:expoBuildId/status", async (req, res) => {
  const { expoBuildId } = req.params;
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Missing token." });

  try {
    const response = await fetch(`https://api.expo.dev/v2/builds/${expoBuildId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ error: data.errors || data });
    }
    const build = data.data || data;
    res.json({
      status: build.status,
      downloadUrl: build.artifacts && build.artifacts.buildUrl,
      logsUrl: build.artifacts && build.artifacts.buildDetailsPageUrl,
      error: build.error || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`ApkForge running on http://localhost:${PORT}`);
});
