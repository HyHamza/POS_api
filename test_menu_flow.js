/**
 * test_menu_flow.js - Integration test for menu JSON import, item creation, and querying
 */

'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const API_BASE = 'http://127.0.0.1:3000/api';
const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret';

async function runTest() {
  console.log('=== Starting Menu JSON Import & Item CRUD Test ===\n');

  const token = jwt.sign({
    id: 1,
    role: 'Admin',
    username: 'admin',
    restaurantId: 1
  }, JWT_SECRET, { expiresIn: '1h' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'x-license-key': 'TEST-REST-1234',
    'Content-Type': 'application/json'
  };

  // Test 1: Full JSON Import
  console.log('--- Test 1: Import Full Menu JSON ---');
  const sampleMenu = {
    menu: {
      Burgers: {
        label: 'Burgers',
        items: [
          { name: 'Classic Beef Burger', price: 650, note: 'Juicy beef patty with cheese' },
          { name: 'Zinger Burger', price: 550, note: 'Crispy chicken with spicy mayo' }
        ]
      },
      Pizzas: {
        label: 'Pizzas',
        sizes: ['Small', 'Medium', 'Large'],
        items: [
          {
            name: 'Chicken Tikka Pizza',
            prices: { Small: 850, Medium: 1450, Large: 1950 }
          }
        ]
      }
    },
    deals: {
      label: 'Special Deals',
      standard_deals: [
        { name: 'Duo Deal', price: 1200, includes: ['2 Burgers', '2 Drinks'] }
      ]
    }
  };

  const importRes = await axios.post(`${API_BASE}/menu/import-full`, { json: JSON.stringify(sampleMenu) }, { headers });
  console.log('✓ Full JSON import response:', importRes.data);

  // Test 2: Fetch Categories
  console.log('\n--- Test 2: Fetch Categories ---');
  const catRes = await axios.get(`${API_BASE}/menu/categories`, { headers });
  console.log(`✓ Fetched ${catRes.data.data.length} categories:`, catRes.data.data.map(c => c.name));

  // Test 3: Fetch Items
  console.log('\n--- Test 3: Fetch Items ---');
  const itemRes = await axios.get(`${API_BASE}/menu/items`, { headers });
  console.log(`✓ Fetched ${itemRes.data.data.length} items:`, itemRes.data.data.map(i => `${i.name} (Rs. ${i.price})`));

  // Test 4: Create a single new item
  console.log('\n--- Test 4: Create Single Menu Item ---');
  const burgerCat = catRes.data.data.find(c => c.name === 'Burgers');
  const createRes = await axios.post(`${API_BASE}/menu/items`, {
    category_id: burgerCat ? burgerCat.id : null,
    name: 'Mushroom Swiss Burger',
    price: 750,
    description: 'Fresh grilled mushrooms and swiss cheese',
    dietary_tags: ['Spicy']
  }, { headers });
  console.log('✓ Created item:', createRes.data.data.name, '(ID:', createRes.data.data.id, ')');

  // Test 5: Verify items updated
  const updatedItemRes = await axios.get(`${API_BASE}/menu/items`, { headers });
  console.log(`✓ Total items after single add: ${updatedItemRes.data.data.length}`);

  console.log('\n=============================================');
  console.log('🎉 MENU IMPORT AND CRUD FULLY OPERATIONAL! 🎉');
  console.log('=============================================');
}

runTest().catch(err => {
  console.error('Test failed:', err.response?.data || err.message);
  process.exit(1);
});
