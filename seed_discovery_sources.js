const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";

const DEFAULT_DISCOVERY_SOURCES = [
  {
    discovery_source_id: "disc-src-cpu",
    category_id: "cpu",
    source_name: "PCPartPicker CPUs",
    source_url: "https://pcpartpicker.com/products/cpu/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-gpu",
    category_id: "gpu",
    source_name: "PCPartPicker GPUs",
    source_url: "https://pcpartpicker.com/products/video-card/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-motherboard",
    category_id: "motherboard",
    source_name: "PCPartPicker Motherboards",
    source_url: "https://pcpartpicker.com/products/motherboard/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-ram",
    category_id: "ram",
    source_name: "PCPartPicker Memory",
    source_url: "https://pcpartpicker.com/products/memory/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-storage",
    category_id: "storage",
    source_name: "PCPartPicker Storage",
    source_url: "https://pcpartpicker.com/products/internal-hard-drive/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-psu",
    category_id: "psu",
    source_name: "PCPartPicker Power Supplies",
    source_url: "https://pcpartpicker.com/products/power-supply/",
    source_type: "category_page",
    active: true
  },
  {
    discovery_source_id: "disc-src-case",
    category_id: "case",
    source_name: "PCPartPicker Cases",
    source_url: "https://pcpartpicker.com/products/case/",
    source_type: "category_page",
    active: true
  }
];

function main() {
  const db = core.readDb(DB_FILE);
  db.discovery_sources = Array.isArray(db.discovery_sources) ? db.discovery_sources : [];

  const existingById = new Map(db.discovery_sources.map(row => [row.discovery_source_id, row]));

  for (const source of DEFAULT_DISCOVERY_SOURCES) {
    if (existingById.has(source.discovery_source_id)) {
      Object.assign(existingById.get(source.discovery_source_id), source);
    } else {
      db.discovery_sources.push(source);
    }
  }

  core.writeDb(db, DB_FILE);

  console.log("Seeded discovery sources:");
  for (const source of DEFAULT_DISCOVERY_SOURCES) {
    console.log(`${source.category_id}: ${source.source_url}`);
  }
}

main();
