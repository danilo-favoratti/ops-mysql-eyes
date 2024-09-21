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

// Middleware to log incoming requests
app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    next();
});

// Apply the authentication middleware to all routes below
app.use(authenticateToken);

// Route to handle SQL queries, generate Mermaid diagrams, and create images
app.post('/query', async (req, res) => {
    const sql = req.body.sql;

    console.log(`Received SQL query: ${sql}`);

    if (!sql) {
        console.error('No SQL query provided');
        return res.status(400).json({ error: 'No SQL query provided' });
    }

    // ... [Validation code remains unchanged] ...

    // Check if the result is in the cache
    const cachedResult = cache.get(sql);
    if (cachedResult) {
        console.log('Cache hit for query:', sql);
        return res.json(cachedResult);
    }

    try {
        // Execute the query safely
        const [results] = await pool.query(sql);
        console.log(`Query executed successfully. Number of records: ${results.length}`);

        // Prepare data for OpenAI API
        const data = JSON.stringify(results, null, 2);

        // Create a prompt for the OpenAI API
        const prompt = `
Given the following JSON data, create a Mermaid diagram that best represents the relationships or flow depicted by the data. Use appropriate Mermaid syntax.

**Important:** Provide only the Mermaid code enclosed within \`\`\`mermaid and \`\`\`. Do not include any explanations or additional text.

Data:
${data}

Mermaid diagram:
`;

        // Send the prompt to the OpenAI API
        const response = await openai.chat.completions.create({
            model: 'gpt-4', // Use 'gpt-3.5-turbo' if 'gpt-4' is not available
            messages: [
                { role: 'user', content: prompt },
            ],
        });

        const assistantMessage = response.choices[0].message.content.trim();
        console.log('Assistant response:', assistantMessage);

        // Extract the Mermaid code from the assistant's response
        const mermaidDiagram = extractMermaidCode(assistantMessage);

        if (!mermaidDiagram) {
            throw new Error('Failed to extract Mermaid diagram from OpenAI response');
        }

        console.log('Extracted Mermaid diagram:', mermaidDiagram);

        // Generate image from Mermaid diagram
        const imageBase64 = await generateMermaidImage(mermaidDiagram);
        if (!imageBase64) {
            throw new Error('Failed to generate image from Mermaid diagram');
        }

        const result = {
            sql,
            mermaidDiagram,
            imageBase64, // Base64 encoded image
        };

        // Store the result in the cache
        cache.set(sql, result);

        // Return the result to the client
        res.json(result);
    } catch (err) {
        console.error('Error processing request:', err.message);
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
        // Create temporary input and output file paths
        const timestamp = Date.now();
        const inputFilePath = path.join(process.cwd(), `diagram-${timestamp}.mmd`);
        const outputFilePath = path.join(process.cwd(), `diagram-${timestamp}.png`);

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

        // Read the generated image file
        const imageBuffer = fs.readFileSync(outputFilePath);

        // Convert the image buffer to a base64 string
        const imageBase64 = imageBuffer.toString('base64');

        // Clean up temporary files
        fs.unlinkSync(inputFilePath);
        fs.unlinkSync(outputFilePath);

        return imageBase64;
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
