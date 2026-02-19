const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Supabase config
const SUPABASE_URL = 'https://hzcgpuctetpfmxisehhe.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh6Y2dwdWN0ZXRwZm14aXNlaGhlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mzk4MjE1MDYsImV4cCI6MjA1NTM5NzUwNn0.RhHFSTCJBm7AJNGpMLdr4bqSLiVDSb1YJiYBsMGrkeo';

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ========== HCP API PROXY ==========
app.get('/api/hcp/:endpoint', async (req, res) => {
    const apiKey = req.headers['x-hcp-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing HCP API key' });

    const { endpoint } = req.params;
    const allowed = ['jobs', 'invoices', 'estimates', 'customers', 'employees'];
    if (!allowed.includes(endpoint)) return res.status(400).json({ error: 'Invalid endpoint' });

    const page = req.query.page || '1';
    const pageSize = req.query.page_size || '20';
    const url = `https://api.housecallpro.com/v1/${endpoint}?page=${page}&page_size=${pageSize}`;

    try {
        const resp = await fetch(url, {
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
        });
        const data = await resp.json();
        res.status(resp.status).json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== HCP CUSTOMER SYNC → CUSTOMER COMMS ==========
app.post('/api/hcp/sync-customers', async (req, res) => {
    const apiKey = req.headers['x-hcp-key'];
    if (!apiKey) return res.status(401).json({ error: 'Missing HCP API key' });

    try {
        // Fetch customers from HCP
        let allCustomers = [];
        let page = 1;
        let hasMore = true;
        while (hasMore && page <= 5) {
            const resp = await fetch(`https://api.housecallpro.com/v1/customers?page=${page}&page_size=50`, {
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
            });
            const data = await resp.json();
            const customers = data.customers || data || [];
            if (!Array.isArray(customers) || customers.length === 0) { hasMore = false; break; }
            allCustomers = allCustomers.concat(customers);
            if (customers.length < 50) hasMore = false;
            page++;
        }

        // Get existing customer channels
        const chResp = await fetch(`${SUPABASE_URL}/rest/v1/cockpit_comms_channels?type=eq.customer&select=id`, {
            headers: { 'apikey': SUPABASE_ANON, 'Authorization': `Bearer ${SUPABASE_ANON}` }
        });
        const existingChannels = await chResp.json();
        const existingIds = new Set((existingChannels || []).map(c => c.id));

        let created = 0;
        for (const cust of allCustomers) {
            const name = ((cust.first_name || '') + ' ' + (cust.last_name || '')).trim();
            if (!name) continue;
            const id = 'cust-' + (cust.id || name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'));
            if (existingIds.has(id)) continue;

            await fetch(`${SUPABASE_URL}/rest/v1/cockpit_comms_channels`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON,
                    'Authorization': `Bearer ${SUPABASE_ANON}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                },
                body: JSON.stringify({ id, name, icon: '👤', type: 'customer' })
            });
            created++;
        }

        res.json({ synced: allCustomers.length, created, existing: existingIds.size });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== HCP WEBHOOK RECEIVER ==========
// Set this URL in HCP webhook settings: https://mission-cockpit-production.up.railway.app/api/hcp/webhook
app.post('/api/hcp/webhook', async (req, res) => {
    const event = req.body;
    const eventType = event.event || event.type || 'unknown';
    const ts = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

    console.log(`[HCP Webhook] ${eventType}`, JSON.stringify(event).slice(0, 200));

    try {
        // Extract customer info from the webhook payload
        let customerName = '';
        let customerId = '';
        let messageText = '';

        const payload = event.data || event;

        // Try to find customer info in different HCP event structures
        if (payload.customer) {
            customerName = ((payload.customer.first_name || '') + ' ' + (payload.customer.last_name || '')).trim();
            customerId = payload.customer.id || '';
        } else if (payload.first_name || payload.last_name) {
            customerName = ((payload.first_name || '') + ' ' + (payload.last_name || '')).trim();
            customerId = payload.id || '';
        }

        // Build human-readable message based on event type
        const eventMessages = {
            'job.created': `New job created${payload.description ? ': ' + payload.description : ''}`,
            'job.scheduled': `Job scheduled${payload.scheduled_start ? ' for ' + payload.scheduled_start.slice(0, 10) : ''}`,
            'job.started': 'Job started — crew is on site',
            'job.on_my_way': 'On my way to the job site',
            'job.completed': `Job completed${payload.total_amount ? ' — $' + payload.total_amount : ''}`,
            'job.paid': `Job paid${payload.total_amount ? ' — $' + payload.total_amount : ''}`,
            'job.canceled': 'Job was canceled',
            'job.updated': 'Job details updated',
            'job.deleted': 'Job was deleted',
            'job.rescheduled': `Job rescheduled${payload.scheduled_start ? ' to ' + payload.scheduled_start.slice(0, 10) : ''}`,
            'estimate.created': `New estimate created${payload.total_amount ? ' — $' + payload.total_amount : ''}`,
            'estimate.sent': 'Estimate sent to customer',
            'estimate.completed': 'Estimate approved',
            'invoice.created': `Invoice created${payload.total_amount ? ' — $' + payload.total_amount : ''}`,
            'invoice.sent': 'Invoice sent to customer',
            'invoice.paid': `Invoice paid${payload.total_amount ? ' — $' + payload.total_amount : ''}`,
            'invoice.payment.succeeded': `Payment received${payload.amount ? ' — $' + payload.amount : ''}`,
            'customer.created': 'New customer added to HCP',
            'customer.updated': 'Customer info updated',
            'lead.created': `New lead${payload.source ? ' from ' + payload.source : ''}`,
            'lead.converted': 'Lead converted to job',
            'lead.lost': 'Lead marked as lost'
        };

        messageText = eventMessages[eventType] || `HCP event: ${eventType}`;

        // If we have a customer, post to their channel
        if (customerName) {
            const channelId = 'cust-' + (customerId || customerName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-'));

            // Ensure channel exists (upsert)
            await fetch(`${SUPABASE_URL}/rest/v1/cockpit_comms_channels`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON,
                    'Authorization': `Bearer ${SUPABASE_ANON}`,
                    'Content-Type': 'application/json',
                    'Prefer': 'resolution=merge-duplicates'
                },
                body: JSON.stringify({ id: channelId, name: customerName, icon: '👤', type: 'customer' })
            });

            // Post the event as a message
            await fetch(`${SUPABASE_URL}/rest/v1/cockpit_comms_messages`, {
                method: 'POST',
                headers: {
                    'apikey': SUPABASE_ANON,
                    'Authorization': `Bearer ${SUPABASE_ANON}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    channel_id: channelId,
                    text: messageText,
                    sender: 'HCP',
                    time: ts
                })
            });
        }

        res.json({ received: true, event: eventType, customer: customerName || 'unknown' });
    } catch (err) {
        console.error('[HCP Webhook Error]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', service: 'mission-cockpit', uptime: process.uptime() });
});

// Fallback to index.html for SPA
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Mission Cockpit server running on port ${PORT}`);
});
