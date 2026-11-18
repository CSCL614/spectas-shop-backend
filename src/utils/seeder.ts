import bcrypt from 'bcryptjs';
import { User, IUser } from '../models/User';
import { Sale } from '../models/Sale';
import { Counter } from '../models/Counter';
import { CustomerFeedback } from '../models/CustomerFeedback';
import { AuditLog } from '../models/AuditLog';
import { DiscountType } from '../types';

export const migrateStickerNumbersToSTK = async (): Promise<void> => {
  try {
    const allSales = await Sale.find().select('_id stickerNumber').lean();
    const existingSet = new Set<string>(
      allSales.map((s) => String(s.stickerNumber || '').trim().toUpperCase())
    );

    let migratedCount = 0;
    let maxSeq = 0;

    for (const s of allSales) {
      const raw = String(s.stickerNumber || '').trim().toUpperCase();
      if (!raw) continue;

      const digits = raw.match(/\d+/g);
      if (digits && digits.length > 0) {
        const num = parseInt(digits[digits.length - 1], 10);
        if (!isNaN(num) && num > maxSeq) {
          maxSeq = num;
        }
      }

      // Safely migrate purely numeric sticker numbers (e.g., "1016" -> "STK-1016")
      if (/^\d+$/.test(raw)) {
        const target = `STK-${raw}`;
        if (!existingSet.has(target)) {
          await Sale.updateOne({ _id: s._id }, { $set: { stickerNumber: target } });
          await CustomerFeedback.updateMany({ orderId: raw }, { $set: { orderId: target } });
          existingSet.delete(raw);
          existingSet.add(target);
          migratedCount++;
        } else {
          console.warn(`[Migration] Skipped migrating "${raw}" to "${target}" because "${target}" already exists.`);
        }
      }
    }

    // Ensure atomic counter is at least maxSeq (never reset downwards to 1001)
    if (maxSeq > 0) {
      const counter = await Counter.findById('stickerNumber');
      if (!counter) {
        await Counter.create({ _id: 'stickerNumber', seq: Math.max(1000, maxSeq) });
      } else if (counter.seq < maxSeq) {
        counter.seq = maxSeq;
        await counter.save();
      }
    }

    if (migratedCount > 0) {
      console.log(`[Migration] Safely migrated ${migratedCount} numeric sticker numbers to STK- format. Highest sequence: ${maxSeq}`);
    }
  } catch (error) {
    console.error('[Migration] Error migrating sticker numbers:', error);
  }
};

const formatDate = (date: Date): string => {
  return date.toISOString().split('T')[0];
};

export const seedPredefinedUsers = async (): Promise<IUser[]> => {
  const usersToSeed = [
    {
      username: 'admin',
      rawPassword: 'Admin@123',
      email: 'admin@spectaclesshop.com',
      fullName: 'System Administrator',
      role: 'ADMIN' as const,
      active: true,
    },
    {
      username: 'salesperson1',
      rawPassword: 'Sales@123',
      email: 'sales1@spectaclesshop.com',
      fullName: 'Salesperson One',
      role: 'SALESPERSON' as const,
      active: true,
    },
    {
      username: 'salesperson2',
      rawPassword: 'Sales@123',
      email: 'sales2@spectaclesshop.com',
      fullName: 'Salesperson Two',
      role: 'SALESPERSON' as const,
      active: true,
    },
  ];

  const results: IUser[] = [];

  for (const item of usersToSeed) {
    let user = await User.findOne({ username: item.username.toLowerCase() });
    if (!user) {
      const hashedPassword = await bcrypt.hash(item.rawPassword, 10);
      user = await User.create({
        username: item.username.toLowerCase(),
        password: hashedPassword,
        email: item.email,
        fullName: item.fullName,
        role: item.role,
        active: item.active,
      });
      console.log(`[Seeder] Created default user: ${item.username} (${item.role})`);
    }
    results.push(user);
  }

  return results;
};

export const seedDummySales = async (force: boolean = false): Promise<number> => {
  const existingCount = await Sale.countDocuments();
  if (existingCount >= 15 && !force) {
    console.log(`[Seeder] Sales collection already contains ${existingCount} records. Skipping seed.`);
    return existingCount;
  }

  if (force) {
    await Sale.deleteMany({});
    console.log('[Seeder] Cleared existing sales records for fresh sample seed.');
  }

  // Get salespersons to associate records
  const sp1 = await User.findOne({ username: 'salesperson1' });
  const sp2 = await User.findOne({ username: 'salesperson2' });
  const admin = await User.findOne({ username: 'admin' });

  const sp1Id = sp1 ? sp1._id.toString() : 'sp1';
  const sp1Name = sp1 ? sp1.fullName : 'Salesperson One';
  const sp2Id = sp2 ? sp2._id.toString() : 'sp2';
  const sp2Name = sp2 ? sp2.fullName : 'Salesperson Two';

  const today = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return formatDate(d);
  };
  const daysAhead = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return formatDate(d);
  };

  const sampleSales = [
    {
      stickerNumber: 'STK-1001',
      companyName: 'Ray-Ban',
      costPrice: 2800,
      originalSellingPrice: 5500,
      discountType: 'FIXED' as DiscountType,
      discountValue: 300,
      discountAmount: 300,
      sellingPrice: 5200,
      advanceAmount: 3000,
      paymentMethod: 'Google Pay',
      expectedDeliveryDate: daysAhead(2),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Rahul Sharma',
      customerMobile: '9876543210',
      saleDate: daysAgo(0), // Today
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1002',
      companyName: 'Oakley',
      costPrice: 4200,
      originalSellingPrice: 8000,
      discountType: 'FIXED' as DiscountType,
      discountValue: 200,
      discountAmount: 200,
      sellingPrice: 7800,
      advanceAmount: 7800,
      paymentMethod: 'PhonePe',
      expectedDeliveryDate: daysAgo(1),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Sneha Patel',
      customerMobile: '9823456781',
      saleDate: daysAgo(1),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1003',
      companyName: 'Titan Eye+',
      costPrice: 1500,
      originalSellingPrice: 3500,
      discountType: 'PERCENTAGE' as DiscountType,
      discountValue: 10,
      discountAmount: 350,
      sellingPrice: 3150,
      advanceAmount: 1500,
      paymentMethod: 'Cash',
      expectedDeliveryDate: daysAgo(3),
      deliveryStatus: 'PENDING' as const, // OVERDUE
      customerName: 'Vikram Verma',
      customerMobile: '9845123456',
      saleDate: daysAgo(5),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1004',
      companyName: 'Fastrack',
      costPrice: 950,
      originalSellingPrice: 2100,
      discountType: 'NONE' as DiscountType,
      discountValue: 0,
      discountAmount: 0,
      sellingPrice: 2100,
      advanceAmount: 2100,
      paymentMethod: 'Paytm',
      expectedDeliveryDate: daysAgo(2),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Pooja Reddy',
      customerMobile: '9734567890',
      saleDate: daysAgo(2),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1005',
      companyName: 'Vogue Eyewear',
      costPrice: 3100,
      originalSellingPrice: 6500,
      discountType: 'FIXED' as DiscountType,
      discountValue: 500,
      discountAmount: 500,
      sellingPrice: 6000,
      advanceAmount: 4000,
      paymentMethod: 'UPI',
      expectedDeliveryDate: daysAhead(3),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Arjun Mehta',
      customerMobile: '9811223344',
      saleDate: daysAgo(0), // Today
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1006',
      companyName: 'Carrera',
      costPrice: 3800,
      originalSellingPrice: 8000,
      discountType: 'PERCENTAGE' as DiscountType,
      discountValue: 10,
      discountAmount: 800,
      sellingPrice: 7200,
      advanceAmount: 5000,
      paymentMethod: 'Credit Card',
      expectedDeliveryDate: daysAhead(1),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Deepak Joshi',
      customerMobile: '9922334455',
      saleDate: daysAgo(3),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1007',
      companyName: 'Prada Eyewear',
      costPrice: 7500,
      originalSellingPrice: 15000,
      discountType: 'FIXED' as DiscountType,
      discountValue: 1000,
      discountAmount: 1000,
      sellingPrice: 14000,
      advanceAmount: 14000,
      paymentMethod: 'Debit Card',
      expectedDeliveryDate: daysAgo(4),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Meera Kapoor',
      customerMobile: '9877889900',
      saleDate: daysAgo(6),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1008',
      companyName: 'Gucci Optical',
      costPrice: 9200,
      originalSellingPrice: 20000,
      discountType: 'PERCENTAGE' as DiscountType,
      discountValue: 10,
      discountAmount: 2000,
      sellingPrice: 18000,
      advanceAmount: 10000,
      paymentMethod: 'Bank Transfer',
      expectedDeliveryDate: daysAgo(1),
      deliveryStatus: 'PENDING' as const, // OVERDUE
      customerName: 'Karan Singhania',
      customerMobile: '9711224466',
      saleDate: daysAgo(4),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1009',
      companyName: 'Tommy Hilfiger',
      costPrice: 2600,
      originalSellingPrice: 6000,
      discountType: 'FIXED' as DiscountType,
      discountValue: 600,
      discountAmount: 600,
      sellingPrice: 5400,
      advanceAmount: 5400,
      paymentMethod: 'Google Pay',
      expectedDeliveryDate: daysAgo(1),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Ananya Rao',
      customerMobile: '9866554433',
      saleDate: daysAgo(1),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1010',
      companyName: 'Polaroid',
      costPrice: 1400,
      originalSellingPrice: 2900,
      discountType: 'NONE' as DiscountType,
      discountValue: 0,
      discountAmount: 0,
      sellingPrice: 2900,
      advanceAmount: 1500,
      paymentMethod: 'Cash',
      expectedDeliveryDate: daysAhead(4),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Suresh Kumar',
      customerMobile: '9944332211',
      saleDate: daysAgo(0), // Today
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1011',
      companyName: 'Lenskart Air',
      costPrice: 1100,
      originalSellingPrice: 2499,
      discountType: 'NONE' as DiscountType,
      discountValue: 0,
      discountAmount: 0,
      sellingPrice: 2499,
      advanceAmount: 2499,
      paymentMethod: 'PhonePe',
      expectedDeliveryDate: daysAgo(3),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Divya Nair',
      customerMobile: '9855443322',
      saleDate: daysAgo(7),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1012',
      companyName: 'Silhouette',
      costPrice: 5500,
      originalSellingPrice: 11000,
      discountType: 'FIXED' as DiscountType,
      discountValue: 500,
      discountAmount: 500,
      sellingPrice: 10500,
      advanceAmount: 6000,
      paymentMethod: 'UPI',
      expectedDeliveryDate: daysAhead(5),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Ramesh Gupta',
      customerMobile: '9788990011',
      saleDate: daysAgo(2),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1013',
      companyName: 'Ray-Ban',
      costPrice: 3200,
      originalSellingPrice: 7000,
      discountType: 'FIXED' as DiscountType,
      discountValue: 500,
      discountAmount: 500,
      sellingPrice: 6500,
      advanceAmount: 6500,
      paymentMethod: 'Debit Card',
      expectedDeliveryDate: daysAgo(2),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Priya Sundaram',
      customerMobile: '9911447788',
      saleDate: daysAgo(3),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
    {
      stickerNumber: 'STK-1014',
      companyName: 'Oakley',
      costPrice: 4800,
      originalSellingPrice: 9500,
      discountType: 'FIXED' as DiscountType,
      discountValue: 600,
      discountAmount: 600,
      sellingPrice: 8900,
      advanceAmount: 5000,
      paymentMethod: 'Credit Card',
      expectedDeliveryDate: daysAhead(2),
      deliveryStatus: 'PENDING' as const,
      customerName: 'Naveen Choudhary',
      customerMobile: '9833221100',
      saleDate: daysAgo(1),
      salespersonId: sp2Id,
      salespersonName: sp2Name,
    },
    {
      stickerNumber: 'STK-1015',
      companyName: 'Titan Eye+',
      costPrice: 1800,
      originalSellingPrice: 4200,
      discountType: 'PERCENTAGE' as DiscountType,
      discountValue: 10,
      discountAmount: 420,
      sellingPrice: 3780,
      advanceAmount: 3780,
      paymentMethod: 'Cash',
      expectedDeliveryDate: daysAgo(5),
      deliveryStatus: 'DELIVERED' as const,
      customerName: 'Harish Varma',
      customerMobile: '9722334411',
      saleDate: daysAgo(8),
      salespersonId: sp1Id,
      salespersonName: sp1Name,
    },
  ];

  for (const s of sampleSales) {
    const remainingBalance = Math.max(0, s.sellingPrice - s.advanceAmount);
    const grossProfit = s.sellingPrice - s.costPrice;

    const paymentTransactions = [];
    if (s.advanceAmount > 0) {
      paymentTransactions.push({
        amount: s.advanceAmount,
        paymentMethod: s.paymentMethod,
        date: s.saleDate,
        time: '11:00 AM',
        notes: 'Initial Advance Payment',
      });
    }

    await Sale.findOneAndUpdate(
      { stickerNumber: s.stickerNumber },
      {
        ...s,
        remainingBalance,
        grossProfit,
        paymentTransactions,
      },
      { upsert: true, new: true }
    );
  }

  // Seed sample customer feedback if empty
  const feedbackCount = await CustomerFeedback.countDocuments();
  if (feedbackCount === 0) {
    await CustomerFeedback.insertMany([
      {
        patientName: 'Rahul Sharma',
        patientPhone: '9876543210',
        orderId: 'STK-1001',
        rating: 5,
        feedback: 'Excellent service and accurate power glasses! Delivered right on time.',
        feedbackDate: daysAgo(0),
        salespersonId: sp1Id,
        salespersonName: sp1Name,
      },
      {
        patientName: 'Sneha Patel',
        patientPhone: '9823456781',
        orderId: 'STK-1002',
        rating: 5,
        feedback: 'Very comfortable Oakley frames. The staff guided me very professionally.',
        feedbackDate: daysAgo(1),
        salespersonId: sp1Id,
        salespersonName: sp1Name,
      },
      {
        patientName: 'Pooja Reddy',
        patientPhone: '9734567890',
        orderId: 'STK-1004',
        rating: 4,
        feedback: 'Great quality progressive lenses at an affordable price.',
        feedbackDate: daysAgo(2),
        salespersonId: sp2Id,
        salespersonName: sp2Name,
      },
      {
        patientName: 'Meera Kapoor',
        patientPhone: '9877889900',
        orderId: 'STK-1007',
        rating: 5,
        feedback: 'Authentic Prada frame, premium packaging, highly recommended!',
        feedbackDate: daysAgo(5),
        salespersonId: sp1Id,
        salespersonName: sp1Name,
      },
      {
        patientName: 'Ananya Rao',
        patientPhone: '9866554433',
        orderId: 'STK-1009',
        rating: 4,
        feedback: 'Very quick optical fitting and polite salesperson.',
        feedbackDate: daysAgo(1),
        salespersonId: sp1Id,
        salespersonName: sp1Name,
      },
    ]);
    console.log('[Seeder] Seeded 5 sample customer feedback records.');
  }

  // Create audit log for seeding
  await AuditLog.create({
    action: 'SEED_DATA',
    entityType: 'SALE',
    entityId: 'ALL',
    performedBy: admin ? admin._id.toString() : 'system',
    performedByName: admin ? admin.fullName : 'System Administrator',
    details: 'Seeded sample optical sales and customer feedback',
    timestamp: new Date().toISOString(),
  });

  const finalCount = await Sale.countDocuments();
  console.log(`[Seeder] Sample sales records seeded successfully. Total in DB: ${finalCount}`);
  return finalCount;
};


