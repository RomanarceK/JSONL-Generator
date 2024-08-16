const express = require('express');
const multer = require('multer');
const fs = require('fs');
const { OpenAI } = require('openai');
require("dotenv").config();
const openaiKey = process.env.OPENAI_KEY;

// Configuración de OpenAI API
const openai = new OpenAI({
    apiKey: openaiKey,
    project: 'proj_Ncjj2if2gtsMh09ypLCLJn1n',
    organization: 'org-5bhCPYUobXKz9DMRqiLFL5ss'
});

// Configuración de Express y Multer
const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.json());

let generatedEntries = [];
let generatedNewEntries = [];
let count = 0;
const maxEntries = 25;
const entryBatchSize = 5;

// Función para limpiar el JSON de posibles etiquetas de formato
function cleanJSON(responseText) {
    return responseText.replace(/```json/g, '').replace(/```/g, '').trim();
}

async function retryRequestWithBackoff(fn, retries = 3) {
    let delay = 4000;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (error) {
            if (error.response && error.response.data && error.response.data.error && error.response.data.error.message.includes('rate_limit_exceeded')) {
                console.log(`Rate limit exceeded. Retry ${i + 1}/${retries} after ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                throw error;
            }
        }
    }
    throw new Error('Max retries reached');
}

async function generateEntries(text, currentEntries, instruction) {
    const fn = async () => {
        count += 1;
        console.log(`Consulta numero: ${count}`);
        const messages = [
            {
                role: 'system',
                content: 'Eres un experto en fine-tuning. Tu tarea es crear entradas JSONL en formato JSON para el entrenamiento de un modelo de IA, a partir de un texto informativo de referencia. Retorna la respuesta en formato JSON, donde cada entrada está estructurada como un objeto con "messages", "role", y "content". Asegúrate de que la salida esté completa y sea un JSON válido.',
            },
            {
                role: 'user',
                content: `Genera ${entryBatchSize} entradas JSONL para entrenar a un modelo de IA, cubriendo la mayor cantidad de escenarios posibles y toda la información del siguiente texto de referencia: ${text}. Las nuevas entradas deben ser únicas, sin repetir ninguna de las anteriores. Usa variaciones en la formulación de las preguntas y las respuestas. Aquí están las entradas anteriores: ${currentEntries}. En este caso, es importante asegurarnos que incluimos toda la información sobre los precios, destinos y fechas. Asegúrate de que la salida esté en un formato JSON válido, correctamente estructurado, y que no falte ninguna llave o carácter necesario para la validez del JSON. La respuesta solo debe ser el array de datos, sin incluir ningún carácter antes o después. Cada entrada debe comenzar con el mensaje de role: system que contenga lo siguiente en el content: ${instruction}`,
            },
        ];

        const completion = await openai.chat.completions.create({
            messages: messages,
            temperature: 0.5,
            max_tokens: 1024,
            model: 'gpt-4o-mini-2024-07-18',
        });

        let jsonlEntries = completion.choices[0].message.content.trim();
        console.log('OPENAI RESULT: ', jsonlEntries);
        jsonlEntries = cleanJSON(jsonlEntries);

        let parsedEntries;
        try {
            parsedEntries = JSON.parse(jsonlEntries);
        } catch (error) {
            console.error('Error al parsear la respuesta:', error);
            return [];
        }

        return parsedEntries;
    };

    return retryRequestWithBackoff(fn);
}

async function generateNewEntries(text, currentEntries) {
    const fn = async () => {
        count += 1;
        console.log(`Consulta numero: ${count}`);
        const messages = [
            {
                role: 'system',
                content: 'Eres un experto en fine-tuning. Tu tarea es crear entradas JSONL en formato JSON para el entrenamiento de un modelo de IA, a partir de un texto informativo de referencia. Retorna la respuesta en formato JSON, donde cada entrada está estructurada como un objeto con "messages", "role", y "content".',
            },
            {
                role: 'user',
                content: `Necesito mejorar la calidad y cantidad de casos en este conjunto de datos JSONL para entrenar un modelo de IA: ${currentEntries}. Ten en cuenta que dicho archivo fue generado en base a esta información: ${text}. Genera 10 nuevas entradas JSONL reformulando las preguntas y respuestas para ganar en variedad y cubriendo información o escenarios que no hayan sido cubiertos anteriormente. Asegúrate de que la salida esté en un formato JSON válido, correctamente estructurado, y que no falte ninguna llave o carácter necesario para la validez del JSON. La respuesta solo debe ser el array de datos no incluyas ningún caracter antes o después. En cada entrada que generes, incluye al principio el message con role: system que tenga el mismo contenido que las entradas jsonl de referencia.`,
            },
        ];

        const completion = await openai.chat.completions.create({
            messages: messages,
            temperature: 0.5,
            max_tokens: 2048,
            model: 'gpt-4o-mini-2024-07-18',
        });

        let jsonlEntries = completion.choices[0].message.content.trim();
        console.log('OPENAI RESULT: ', jsonlEntries);
        jsonlEntries = cleanJSON(jsonlEntries);

        let parsedEntries;
        try {
            parsedEntries = JSON.parse(jsonlEntries);
        } catch (error) {
            console.error('Error al parsear la respuesta:', error);
            return [];
        }

        return parsedEntries;
    };

    return retryRequestWithBackoff(fn);
}

// Endpoint para subir archivo y generar entries
app.post('/upload', upload.single('file'), async (req, res) => {
    const text = fs.readFileSync(req.file.path, 'utf8');
    const instruction = req.body.instruction || '';

    generatedEntries = await generateEntries(text, '', instruction);
    while (generatedEntries.length < maxEntries) {
        const newEntries = await generateEntries(text, JSON.stringify(generatedEntries), instruction);
        generatedEntries = generatedEntries.concat(newEntries);

        if (newEntries.length === 0) {
            break;
        }
    }

    fs.unlinkSync(req.file.path);
    res.status(200).json({ message: 'Entries generated', count: generatedEntries.length });
});

// Endpoint para generar un nuevo archivo a partir de un jsonl
app.post('/upload-new', upload.fields([{ name: 'file' }, { name: 'jsonl' }]), async (req, res) => {
    const text = fs.readFileSync(req.files['file'][0].path, 'utf8');
    const currentEntries = fs.readFileSync(req.files['file'][1].path, 'utf8');

    let generatedNewEntries = await generateNewEntries(text, currentEntries);

    fs.unlinkSync(req.files['file'][0].path);
    fs.unlinkSync(req.files['file'][1].path);
    
    res.status(200).json({ message: 'New entries generated', count: generatedNewEntries.length });
});

// Endpoint para descargar el archivo JSONL generado
app.get('/download', (req, res) => {
    const jsonlContent = generatedEntries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync('generated-dataset.jsonl', jsonlContent);

    res.download('generated-dataset.jsonl');
});

// Endpoint para descargar el archivo JSONL generado
app.get('/download-new', (req, res) => {
    const jsonlContent = generatedNewEntries.map(entry => JSON.stringify(entry)).join('\n');
    fs.writeFileSync('generated-new-dataset.jsonl', jsonlContent);

    res.download('generated-new-dataset.jsonl');
});

// Iniciar servidor
app.listen(3002, () => {
    console.log('Server is running on http://localhost:3002');
});