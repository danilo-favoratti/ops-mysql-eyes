// Load environment variables from .env
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import mysql from 'mysql2/promise'; // Promise-based MySQL client
import OpenAI from 'openai'; // Import OpenAI default export
import { LRUCache } from 'lru-cache';
import { exec } from 'child_process'; // For executing shell commands
import fs from 'fs';
import path from 'path';

const app = express();
const port = process.env.SERVER_PORT || 1413;

// Middleware to parse JSON bodies
app.use(express.json());

// Ensure the 'diagrams' directory exists
const diagramsDir = path.join(process.cwd(), 'diagrams');
if (!fs.existsSync(diagramsDir)) {
    fs.mkdirSync(diagramsDir);
}

// Serve static files from the 'diagrams' directory
app.use('/diagrams', express.static(diagramsDir));

// Authentication Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Extract token from "Bearer <token>"

    if (!token) {
        console.error('No token provided');
        return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    if (token !== process.env.AUTH_TOKEN) {
        console.error('Invalid token');
        return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    next(); // Token is valid
};

// Middleware to log incoming requests
app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    next();
});

// Apply the authentication middleware to all routes below
app.use(authenticateToken);

// Create a connection pool using environment variables
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER, // Ensure this user has read-only permissions
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// OpenAI API Configuration
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Initialize LRU Cache
const cache = new LRUCache({
    max: 500,
    ttl: 1000 * 60 * 5,
});

// Log when the server starts
console.log('Server is starting...');

// Endpoint to handle SQL queries
app.post('/sql-query', async (req, res) => {
    const sql = JSON.stringify(req.body.sql).slice(1, -1);

    console.log(`Received SQL query: ${sql}`);

    if (!sql) {
        console.error('No SQL query provided');
        return res.status(400).json({ error: 'No SQL query provided' });
    }

    // Basic validation: Ensure the query starts with 'SELECT' and doesn't contain forbidden keywords
    const trimmedSql = sql.trim().toUpperCase();
    if (!trimmedSql.startsWith('SELECT')) {
        console.error('Invalid query: Only SELECT statements are allowed');
        return res.status(400).json({ error: 'Only SELECT statements are allowed' });
    }

    // Disallow certain dangerous keywords
    const forbiddenPatterns = /(\b(ALTER|DROP|DELETE|INSERT|UPDATE|TRUNCATE|EXEC|MERGE|CALL|UNION|--|;|\*\/|\/\*)\b)/i;
    if (forbiddenPatterns.test(sql)) {
        console.error('Forbidden keyword detected in SQL query');
        return res.status(400).json({ error: 'Invalid or unsafe SQL query' });
    }

    // Limit query length to prevent overly long queries
    if (sql.length > 1000) {
        console.error('SQL query exceeds maximum allowed length');
        return res.status(400).json({ error: 'SQL query is too long' });
    }

    // Check if the result is in the cache
    const cachedResult = cache.get(sql);
    if (cachedResult) {
        console.log('Cache hit for query:', sql);
        return res.json({
            sql,
            data: cachedResult,
        });
    }

    try {
        // Execute the query safely
        const [results] = await pool.query(sql);
        console.log(`Query executed successfully. Number of records: ${results.length}`);

        // Handle zero results
        if (results.length === 0) {
            console.log('No data found for the given query.');
            return res.status(200).json({
                message: 'No data found for the given query. Please check your query and try again.',
                sql,
            });
        }

        // Store the result in the cache
        cache.set(sql, results);

        // Return the data to the client
        return res.json({
            sql,
            data: results,
        });

    } catch (err) {
        console.error('Error executing SQL query:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to generate Mermaid diagrams and images
app.post('/generate-mermaid', async (req, res) => {
    const data = req.body.data

    if (!data) {
        console.error('No data provided for Mermaid diagram generation');
        return res.status(400).json({ error: 'No data provided' });
    }

    // Convert data to string if necessary
    const dataString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

    // Create a prompt for the OpenAI API
    const prompt = `
#MISSION
Given the following JSON data, create a Mermaid diagram that best represents the relationships or flow depicted by the data. Use appropriate Mermaid syntax.

#EXAMPLES
##Example Gantt Diagram:
gantt
    title A Gantt Diagram
    dateFormat YYYY-MM-DD
    section Section
        A task          :a1, 2014-01-01, 30d
        Another task    :after a1, 20d
    section Another
        Task in Another :2014-01-12, 12d
        another task    :24d

##Example Pie Chart:
pie title Cost by Deputy
    "Deputy A" : 386
    "Deputy B" : 85
    "Deputy C" : 15

##Example Cost Journey:
journey
    title Cost Per Month
    section January
      Flights: 5: Me
      Office Supply: 3: Me
      Taxi: 1: Me, Joe
    section February
      Flights: 6: Me
      Office Supply: 5: Me

##Example Timeline
timeline
    title History of expenditure
    Jan/2021 : R$ 1000
    Fev/2021 : R$ 2000
    Mar/2021 : R$ 4500
    Abr/2021 : R$ 2000

##Example XY Chart
xychart-beta
    title "Cost vs Total Cost"
    x-axis [jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
    line [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]

##IMPORTANT
**Important:** Provide only the Mermaid code enclosed within \`\`\`mermaid and \`\`\`. Do not include any explanations or additional text.

Data:
${dataString}

Mermaid diagram:
`;

    try {
        // Check if the result is in the cache
        const cacheKey = JSON.stringify(data);
        const cachedResult = cache.get(cacheKey);
        if (cachedResult) {
            console.log('Cache hit for data:', cacheKey);
            return res.json(cachedResult);
        }

        // Send the prompt to the OpenAI API
        const response = await openai.chat.completions.create({
            model: 'gpt-4o', // Use 'gpt-3.5-turbo' or another model if 'gpt-4' is not available
            messages: [
                { role: 'user', content: prompt },
            ],
        });

        const assistantMessage = response.choices[0].message.content.trim();
        console.log('Assistant response:', assistantMessage);

        // Extract the Mermaid code from the assistant's response
        const mermaidDiagram = extractMermaidCode(assistantMessage);

        if (!mermaidDiagram) {
            console.warn('Failed to extract Mermaid diagram from OpenAI response');
            return res.status(500).json({ error: 'Failed to generate Mermaid diagram' });
        }

        console.log('Extracted Mermaid diagram:', mermaidDiagram);

        // Generate image from Mermaid diagram
        const imageName = await generateMermaidImage(mermaidDiagram);

        if (!imageName) {
            console.warn('Failed to generate image from Mermaid diagram');
            return res.status(500).json({ error: 'Failed to generate image from Mermaid diagram' });
        }

        // Construct the image URL
        const imageUrl = `https://ops.favoratti.com/diagrams/${imageName}`;

        const result = {
            mermaidDiagram,
            imageUrl,
        };

        // Store the result in the cache
        cache.set(cacheKey, result);

        // Return the result to the client
        res.json(result);

    } catch (err) {
        console.error('Error generating Mermaid diagram:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Helper function to extract Mermaid code from the assistant's response
const extractMermaidCode = (text) => {
    // Use regex to find code blocks with mermaid syntax
    const codeBlockRegex = /```mermaid\n([\s\S]*?)```/i;
    const match = text.match(codeBlockRegex);
    if (match && match[1]) {
        return match[1].trim();
    } else {
        // If no code block is found, return null
        return null;
    }
};

// Function to generate an image from Mermaid code using mermaid-cli
const generateMermaidImage = async (mermaidCode) => {
    try {
        // Create unique image name
        const timestamp = Date.now();
        const imageName = `diagram-${timestamp}.png`;
        const inputFilePath = path.join(diagramsDir, `diagram-${timestamp}.mmd`);
        const outputFilePath = path.join(diagramsDir, imageName);

        // Write the Mermaid code to the input file
        fs.writeFileSync(inputFilePath, mermaidCode);

        // Construct the command to execute mermaid-cli
        const command = `npx -p @mermaid-js/mermaid-cli mmdc -i "${inputFilePath}" -o "${outputFilePath}" --quiet`;

        // Execute the command
        await new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error executing mermaid-cli: ${stderr}`);
                    reject(new Error(stderr || 'Error executing mermaid-cli'));
                } else {
                    resolve();
                }
            });
        });

        // Clean up temporary input file
        fs.unlinkSync(inputFilePath);

        // Return the image name
        return imageName;
    } catch (error) {
        console.error('Error generating Mermaid image:', error.message);
        return null;
    }
};

// Start the server with enhanced error handling
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
}).on('error', (err) => {
    console.error('Server failed to start:', err);
});
