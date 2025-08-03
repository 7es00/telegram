import mongoose from "mongoose";

// غيّر هنا بيانات الاتصال لو لازم
const MONGODB_URI = "mongodb+srv://mody:11556000@modyb.roi8ozk.mongodb.net/mybotdb"; // غير mybotdb لو داتابيزك اسمها مختلف

// SCHEMAS
const PlatformSchema = new mongoose.Schema({ name: String });
const ServiceSchema = new mongoose.Schema({
  platform: String,
  type: String,
  display_name: String,
  min_qty: Number,
  max_qty: Number,
  pricing_mode: String,
  description: String,
});
const PricingSchema = new mongoose.Schema({
  service_id: mongoose.Schema.Types.ObjectId,
  mode: String,
  unit_size: Number,
  price_usd: Number,
  qty_from: Number,
  qty_to: Number,
  price_per_unit: Number,
});

const Platform = mongoose.model('Platform', PlatformSchema);
const Service = mongoose.model('Service', ServiceSchema);
const Pricing = mongoose.model('Pricing', PricingSchema);

async function seed() {
  await mongoose.connect(MONGODB_URI);

  // 1. Add platforms (upsert)
  const platforms = ["instagram", "tiktok", "twitter", "youtube"];
  await Platform.deleteMany({});
  await Platform.insertMany(platforms.map(name => ({ name })));
  console.log('Platforms seeded.');

  // 2. Add services for each platform
  await Service.deleteMany({});
  const serviceTypes = [
    {
      type: "follower",
      display_name: "Followers",
      min_qty: 10,
      max_qty: 10000,
      description: "High quality followers"
    },
    {
      type: "like",
      display_name: "Likes",
      min_qty: 10,
      max_qty: 10000,
      description: "Real likes"
    },
    {
      type: "comment",
      display_name: "Comments",
      min_qty: 1,
      max_qty: 500,
      description: "Custom user comments"
    },
    {
      type: "view",
      display_name: "Views",
      min_qty: 100,
      max_qty: 100000,
      description: "Real views"
    }
  ];

  const allServices = [];
  for (const platform of platforms) {
    for (const service of serviceTypes) {
      allServices.push({
        platform,
        type: service.type,
        display_name: service.display_name,
        min_qty: service.min_qty,
        max_qty: service.max_qty,
        pricing_mode: "flat",
        description: `${platform.charAt(0).toUpperCase() + platform.slice(1)} ${service.description}`,
      });
    }
  }
  const insertedServices = await Service.insertMany(allServices);
  console.log('Services seeded.');

  // 3. Add pricing for each service
  await Pricing.deleteMany({});
  const pricingDocs = [];
  for (const service of insertedServices) {
    let price = 2;
    if (service.type === "follower") price = 3;
    if (service.type === "comment") price = 10;
    if (service.type === "view") price = 1;
    pricingDocs.push({
      service_id: service._id,
      mode: "flat",
      unit_size: 100,
      price_usd: price
    });
  }
  await Pricing.insertMany(pricingDocs);
  console.log('Pricing seeded.');

  await mongoose.disconnect();
  console.log('🌱 All done! All platforms/services/pricing are ready in your database.');
}

seed().catch(e => {
  console.error(e);
  mongoose.disconnect();
});
