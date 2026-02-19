exports.handler = async function(event) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, x-hcp-key',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    const apiKey = event.headers['x-hcp-key'];
    if (!apiKey) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Missing HCP API key' }) };
    }

    const params = event.queryStringParameters || {};
    const endpoint = params.endpoint || 'jobs';
    const page = params.page || '1';
    const pageSize = params.page_size || '20';

    const allowed = ['jobs', 'invoices', 'estimates', 'customers', 'employees'];
    if (!allowed.includes(endpoint)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid endpoint' }) };
    }

    const url = `https://api.housecallpro.com/v1/${endpoint}?page=${page}&page_size=${pageSize}`;

    try {
        const resp = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });
        const data = await resp.json();
        return { statusCode: resp.status, headers, body: JSON.stringify(data) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
    }
};
