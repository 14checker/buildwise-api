const core = require("./buildwise_backend_core");

const DB_FILE = process.env.DB_FILE || "db.json";
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

function nextId(rows, field, prefix, width) {
  let max = 0;
  for (const row of rows || []) {
    const value = row?.[field];
    if (!value || typeof value !== "string") continue;
    const match = value.match(new RegExp(`^${prefix}-(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${String(max + 1).padStart(width, "0")}`;
}

function main() {
  const db = core.readDb(DB_FILE);
  db.alert_queue = Array.isArray(db.alert_queue) ? db.alert_queue : [];

  const offersByProduct = new Map();
  for (const offer of db.retailer_offers) {
    if (!offersByProduct.has(offer.product_id)) offersByProduct.set(offer.product_id, []);
    offersByProduct.get(offer.product_id).push(offer);
  }

  let checked = 0;
  let created = 0;

  for (const alert of db.price_alerts || []) {
    const status = core.normalizeKey(alert.status || "active");
    if (!["active", "enabled", "pending"].includes(status)) continue;

    checked++;
    const productId = alert.product_id;
    const targetPrice = Number(alert.target_price || alert.price_threshold || alert.threshold_price);
    if (!productId || !Number.isFinite(targetPrice)) continue;

    const offers = offersByProduct.get(productId) || [];
    const bestOffer = offers
      .filter(offer => Number.isFinite(Number(offer.current_price)))
      .sort((a, b) => Number(a.current_price) - Number(b.current_price))[0];

    if (!bestOffer) continue;

    if (Number(bestOffer.current_price) <= targetPrice) {
      const alreadyQueued = db.alert_queue.some(row => row.alert_id === alert.alert_id && row.retailer_offer_id === bestOffer.retailer_offer_id && core.normalizeKey(row.status) !== "sent");
      if (alreadyQueued) continue;

      db.alert_queue.push({
        queue_id: nextId(db.alert_queue, "queue_id", "alertq", 8),
        alert_id: alert.alert_id || null,
        user_id: alert.user_id || null,
        product_id: productId,
        retailer_offer_id: bestOffer.retailer_offer_id,
        trigger_price: Number(bestOffer.current_price),
        target_price: targetPrice,
        status: "pending",
        created_at: core.nowBase44DateTime()
      });
      created++;
    }
  }

  if (!DRY_RUN) core.writeDb(db, DB_FILE);

  console.log("Alert engine complete.");
  console.log({ dry_run: DRY_RUN, alerts_checked: checked, alerts_queued: created });
}

main();
