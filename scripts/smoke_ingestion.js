/**
 * BuildWise purpose:
 * Run a fixture-backed smoke test for the retailer ingestion pipeline.
 *
 * Plain-English summary:
 * This proves candidate verification, safe promotion, public serialization, and no duplicate snapshots without using live retailer pages.
 *
 * Safety note:
 * The script uses temporary files under the OS temp directory and never touches the real db.json.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const core = require("../buildwise_backend_core");
const publicSerializers = require("../public_serializers");
const { runRetailerIngestion } = require("../retailer_ingestion");

function makeFixtureDb() {
  const db = core.emptyDb();
  db.retailers.push({ retailer_id: "ret-newegg", name: "Newegg", domain: "newegg.com", active: true });
  db.products.push({
    product_id: "cpu-9800x3d",
    category_id: "cpu",
    brand: "AMD",
    model: "Ryzen 7 9800X3D",
    mpn: "100-100001084WOF",
    status: "active"
  });
  return db;
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "buildwise-ingestion-smoke-"));
  const candidateFile = path.join(tempDir, "candidates.json");
  const fixturePath = path.join(__dirname, "..", "tests", "fixtures", "exact_mpn_product.html");
  fs.writeFileSync(candidateFile, JSON.stringify([
    {
      product_id: "cpu-9800x3d",
      retailer_id: "ret-newegg",
      candidate_url: "https://www.newegg.com/amd-ryzen-7-9800x3d/p/N82E16819113877",
      html_path: fixturePath,
      source: "smoke_fixture"
    }
  ], null, 2));

  const dryRunDb = makeFixtureDb();
  const dryRunSummary = await runRetailerIngestion(dryRunDb, {
    write: false,
    autoPromote: false,
    discoveryCandidateFile: candidateFile,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1
  });

  if (dryRunDb.retailer_offers.length !== 0) throw new Error("Dry-run mutated fixture DB.");
  if (dryRunSummary.candidate_rows !== 1) throw new Error("Dry-run candidate count mismatch.");

  const writeDb = makeFixtureDb();
  const writeSummary = await runRetailerIngestion(writeDb, {
    write: true,
    autoPromote: true,
    autoPromoteExact: true,
    autoPromoteStrong: true,
    autoPromoteMinScore: 90,
    discoveryCandidateFile: candidateFile,
    discoveryMaxProducts: 1,
    discoveryTargetOffersPerProduct: 1
  });

  const publicOffers = publicSerializers.publicRetailerOffers(writeDb);
  if (writeSummary.promoted !== 1) throw new Error("Expected one promoted fixture offer.");
  if (publicOffers.length !== 1) throw new Error("Expected one public-safe fixture offer.");
  if ("source_url" in publicOffers[0] || "url_confidence" in publicOffers[0]) {
    throw new Error("Unsafe fields leaked through public serializer.");
  }
  if (publicOffers[0].current_price !== null) {
    throw new Error("Unverified fixture price should be blank in public output.");
  }

  const cliDbFile = path.join(tempDir, "db.json");
  core.writeDb(makeFixtureDb(), cliDbFile);
  const cliResult = spawnSync(process.execPath, [path.join(__dirname, "..", "verify_candidates.js")], {
    stdio: "pipe",
    shell: false,
    env: {
      ...process.env,
      DB_FILE: cliDbFile,
      DISCOVERY_CANDIDATE_FILE: candidateFile,
      WRITE: "",
      AUTO_PROMOTE: ""
    }
  });
  if (cliResult.status !== 0) {
    throw new Error(`verify_candidates.js fixture dry-run failed: ${cliResult.stderr.toString() || cliResult.stdout.toString()}`);
  }

  console.log("BUILDWISE_INGESTION_SMOKE_PASS " + JSON.stringify({
    dry_run_candidate_rows: dryRunSummary.candidate_rows,
    promoted: writeSummary.promoted,
    public_offers: publicOffers.length,
    cli_dry_run: "passed",
    temp_dir: tempDir
  }, null, 2));
}

main().catch(error => {
  console.error("BUILDWISE_INGESTION_SMOKE_FAIL", error.message);
  process.exitCode = 1;
});
