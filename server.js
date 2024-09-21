require('dotenv').config(); // Load environment variables from .env

const express = require('express');
const mysql = require('mysql2');
const app = express();
const port = process.env.SERVER_PORT || 1413; // Use port from .env or default to 1413

// Middleware to parse JSON bodies
app.use(express.json());

// Create a connection pool using environment variables
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306, // Default to 3306 if not specified
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Log when the server starts
console.log(`Server is starting...`);

// Middleware to log incoming requests
app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    next();
});

// Route to handle SQL queries
app.post('/query', (req, res) => {
    const sql = req.body.sql;

    // Log the received SQL query
    console.log(`Received SQL query: ${sql}`);

    if (!sql) {
        console.error('No SQL query provided');
        return res.status(400).json({ error: 'No SQL query provided' });
    }

    // Validate that the query is a SELECT statement
    const trimmedSql = sql.trim().toUpperCase();
    if (!trimmedSql.startsWith('SELECT')) {
        console.error('Invalid query: Only SELECT statements are allowed');
        return res.status(400).json({ error: 'Only SELECT statements are allowed' });
    }

    // Execute the query
    pool.query(sql, (error, results) => {
        if (error) {
            console.error(`Query execution error: ${error.message}`);
            return res.status(500).json({ error: error.message });
        }
        // Log the successful query result
        console.log(`Query executed successfully. Number of records: ${results.length}`);
        res.json(results);
    });
});

// Start the server with enhanced error handling
try {
    app.listen(port, () => {
        console.log(`Server is running on port ${port}`);
    }).on('error', (err) => {
        console.error('Server failed to start:', err);
    });
} catch (err) {
    console.error('Unexpected error starting server:', err);
}
