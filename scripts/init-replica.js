const mongoose = require('mongoose');

async function initReplicaSet() {
    try {
        // Connect to the admin database directly
        await mongoose.connect('mongodb://127.0.0.1:27017/admin?directConnection=true');
        console.log('Connected to MongoDB.');

        const admin = mongoose.connection.db.admin();

        try {
            const status = await admin.command({ replSetGetStatus: 1 });
            console.log('Replica set status:', status.ok === 1 ? 'OK' : 'Unknown');
            if (status.ok === 1 && status.set === 'rs0') {
                console.log('Replica Set "rs0" is ALREADY initialized. You are good to go! ✅');
                process.exit(0);
            }
        } catch (err) {
            if (err.codeName === 'NotYetInitialized' || err.message.includes('run rs.initiate')) {
                console.log('Replica Set is not initialized. Initializing now...');
                // Initialize
                const result = await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
                console.log('Replica Set initialized successfully! Result:', result);
                console.log('Please restart your backend server now. ✅');
            } else {
                console.error('Error checking status:', err.message);
                // If error is "no replset config has been received", it confirms we need to initiate
                if (err.message.includes('no replset config has been received')) {
                    const result = await admin.command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] } });
                    console.log('Replica Set initialized successfully! ✅');
                }
            }
        }

    } catch (error) {
        if (error.message.includes('ECONNREFUSED')) {
            console.error('❌ Error: Could not connect to MongoDB.');
            console.error('Make sure your MongoDB Service is STARTED.');
        } else {
            console.error('❌ An unexpected error occurred:', error);
        }
    } finally {
        await mongoose.disconnect();
    }
}

initReplicaSet();
