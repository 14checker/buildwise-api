const express = require("express");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const PRODUCTS = [
  {
    id: "cpu_1",
    category: "CPU",
    name: "AMD Ryzen 5 9600X"
  },
  {
    id: "cpu_2",
    category: "CPU",
    name: "AMD Ryzen 7 7800X3D"
  },
  {
    id: "cpu_3",
    category: "CPU",
    name: "Intel Core i7-14700K"
  }
];

app.get("/products", (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync("db.json"));
    res.json(db);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/latest", (req, res) => {
  try {
    const db = JSON.parse(fs.readFileSync("db.json"));

    const latestProducts = [];

    for (const product of PRODUCTS) {

      const snapshots = db[product.id];

      if (!snapshots || snapshots.length === 0) continue;

      const latestSnapshot =
        snapshots[snapshots.length - 1];

      const prices = latestSnapshot.prices;

      if (!prices || prices.length === 0) continue;

      const lowestPriceEntry = prices.reduce(
        (lowest, current) =>
          current.price < lowest.price
            ? current
            : lowest
      );

      latestProducts.push({
        id: product.id,
        name: product.name,
        category: product.category,
        lowestPrice: lowestPriceEntry.price,
        lowestPriceMerchant:
          lowestPriceEntry.merchant,
        lastUpdated: latestSnapshot.date
      });
    }

    res.json(latestProducts);

  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 API running on port ${PORT}`);
});