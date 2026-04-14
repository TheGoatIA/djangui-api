const mongoose = require('mongoose');
require('dotenv').config();

async function verify() {
  try {
    const uri = "mongodb://admin:your_strong_password@localhost:15001/kauri?authSource=admin&replicaSet=rs0";
    await mongoose.connect(uri);
    console.log('Connected to MongoDB');

    const User = mongoose.connection.collection('users');
    const UserActivity = mongoose.connection.collection('useractivities');
    const Transaction = mongoose.connection.collection('transactions');

    const fiveDaysAgo = new Date();
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);

    console.log(`Checking activity since: ${fiveDaysAgo.toISOString()}`);

    const [activityIds, transactionIds] = await Promise.all([
      UserActivity.distinct('userId', { createdAt: { $gte: fiveDaysAgo } }),
      Transaction.distinct('userId', { createdAt: { $gte: fiveDaysAgo } })
    ]);

    const allActiveIds = [...new Set([...activityIds, ...transactionIds])];
    
    console.log(`- Users with recent activity entries: ${activityIds.length}`);
    console.log(`- Users with recent transactions: ${transactionIds.length}`);
    console.log(`- Total unique active users: ${allActiveIds.length}`);

    const activeUsers = await User.countDocuments({ 
      _id: { $in: allActiveIds },
      isActive: true 
    });

    console.log(`- Final count for Daily Advice: ${activeUsers}`);

    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

verify();
