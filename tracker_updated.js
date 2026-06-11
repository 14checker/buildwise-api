const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

const DB_FILE = "db.json";
const CRAWL_DELAY_MS = 61000;

// PRODUCT CONFIG
const PRODUCTS = [
  {
    id: "cpu_1",
    category: "CPU",
    name: "AMD Ryzen 5 9600X",
    url: "https://pcpartpicker.com/product/4r4Zxr/amd-ryzen-5-9600x-39-ghz-6-core-processor-100-100001405wof"
  },
  {
    id: "cpu_2",
    category: "CPU",
    name: "AMD Ryzen 7 7800X3D",
    url: "https://pcpartpicker.com/product/3hyH99/amd-ryzen-7-7800x3d-42-ghz-8-core-processor-100-100000910wof"
  },
  {
    id: "cpu_3",
    category: "CPU",
    name: "Intel Core i7-14700K",
    url: "https://pcpartpicker.com/product/BmWJ7P/intel-core-i7-14700k-34-ghz-20-core-processor-bx8071514700k"
  }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parsePrice(priceText) {
  const match = priceText.match(/\$?([0-9,]+(?:\.[0-9]{2})?)/);

  if (!match) return null;

  const price = Number(match[1].replace(/,/g, ""));

  return Number.isFinite(price) ? price : null;
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (err) {
    console.error("❌ Failed to read db.json:", err.message);
    return {};
  }
}

function saveSnapshot(product, timestamp, prices) {
  if (!prices.length) {
    console.warn(`⚠️ No prices found for ${product.name}; snapshot not saved.`);
    return;
  }

  const db = readDb();

  if (!db[product.id]) {
    db[product.id] = [];
  }

  db[product.id].push({
    productId: product.id,
    category: product.category,
    name: product.name,
    url: product.url,
    timestamp,
    date: new Date(timestamp).toISOString(),
    prices
  });

  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));

  console.log(`✅ Saved ${prices.length} prices for ${product.name}`);
}

async function scrape(product) {
  const timestamp = Date.now();

  try {
    console.log(`\nScraping ${product.name}...`);

    const { data } = await axios.get(product.url, {
      headers: {
        "User-Agent": "BuildWisePrototype/0.1 contact: 14checker@gmail.com",
        "Accept-Language": "en-US,en;q=0.9"
      },
      timeout: 15000
    });

    const $ = cheerio.load(data);

    const prices = [];

    $("tr").each((i, row) => {
      const merchant = $(row).find(".td__logo img").attr("alt")?.trim();
      const priceText = $(row).find(".td__base").text().trim();

      const price = parsePrice(priceText);

      if (merchant && price !== null) {
        prices.push({
          productId: product.id,
          productName: product.name,
          productUrl: product.url,
          category: product.category,
          merchant,
          price,
          timestamp,
          date: new Date(timestamp).toISOString()
        });
      }
    });

    console.log("Prices found:", prices);

    saveSnapshot(product, timestamp, prices);
  } catch (err) {
    console.error(`❌ Error scraping ${product.name}:`, err.message);
  }
}

async function runAll() {
  for (let i = 0; i < PRODUCTS.length; i++) {
    await scrape(PRODUCTS[i]);

    if (i < PRODUCTS.length - 1) {
      console.log("Waiting before next request...");
      await sleep(CRAWL_DELAY_MS);
    }
  }
}

runAll();
