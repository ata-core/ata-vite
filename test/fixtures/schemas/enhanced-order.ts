import order from './order.json' with {type: 'json'};

(order.properties as Record<string, unknown>)['tax'] = { type: 'number' }

export default order;