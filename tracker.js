const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

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

// MAIN SCRAPER
async function scrape(product) {
  try {
    console.log("Running scraper...");

    const { data } = await axios.get(product.url, {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept-Language": "en-US,en;q=0.9"
  }
});
    const $ = cheerio.load(data);

    // ONE timestamp for entire scrape
    const now = Date.now();

    let prices = [];

    $("tr").each((i, row) => {
      const merchant = $(row).find(".td__logo img").attr("alt") || "unknown";
      const priceText = $(row).find(".td__base").text().trim();

      if (priceText) {
        let price = parseFloat(priceText.replace(/[^0-9.]/g, ""));

        if (!isNaN(price) && merchant !== "unknown") {
          const entry = {
  category: product.category,
  merchant,
  price,
  timestamp: now,
  date: new Date(now).toLocaleString()
};


          prices.push(entry);
        }
      }
    });

    console.log("All prices:", prices);

    // Save snapshot
    saveAllPrices(product.id, prices);

  } catch (err) {
    console.error(`❌ Error scraping ${product.name} (${product.url}):`, err.message);
  }
}

// SAVE FUNCTION
function saveAllPrices(productId, newEntries) {
  let db = {};

  if (fs.existsSync("db.json")) {
    db = JSON.parse(fs.readFileSync("db.json"));
  }

  if (!db[productId]) {
    db[productId] = [];
  }

  const now = Date.now();

  db[productId].push({
    timestamp: now,
    date: new Date(now).toLocaleString(),
    prices: newEntries
  });

  fs.writeFileSync("db.json", JSON.stringify(db, null, 2));

  console.log("✅ Saved full price snapshot");
}

// RUN
async function runAll() {
  for (const product of PRODUCTS) {
    console.log(`\nScraping ${product.name}...`);

    await scrape(product);
  }
}

runAll();