import user from './user.json' with {type: 'json'};

user.properties['age'] = { type: 'number' }

export default user;