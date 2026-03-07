module.exports = {
    apps: [
        {
            name: 'kauri-api',
            script: 'dist/server.js',
            instances: 'max', // Utilise tous les CPU disponibles
            exec_mode: 'cluster', // Active le Load Balancing de PM2
            autorestart: true,
            watch: false,
            max_memory_restart: '2G', // Redémarre si le processus dépasse 2Go de RAM
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
