// Cloudflare Workers handler for personalized feed
import { connect } from '@planetscale/database';

const setCorsHeaders = (request) => {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return headers;
};

// Enhanced feed algorithm with discovery-first approach
export default {
  async fetch(request, env, ctx) {
    const headers = setCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers });
    }

    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ message: 'Method Not Allowed' }), {
        status: 405,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }

    try {
      const db = connect({
        host: env.DB_HOST,
        username: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME
      });

      const defaultPfp = 'https://latestnewsandaffairs.site/public/pfp.jpg';
      const url = new URL(request.url);
      const query = Object.fromEntries(url.searchParams);

      const {
        username,
        username_like,
        start_timestamp,
        end_timestamp,
        page = 1,
        limit = 10,
        sort,
        userId
      } = query;

      // Handle user profile fetch
      if (username && !username_like && !start_timestamp && !end_timestamp && !userId) {
        return await handleUserProfile(db, username, headers);
      }

      // Handle personalized feed (only for 'general' sort or no sort specified)
      if (userId && (sort === 'general' || !sort)) {
        return await handlePersonalizedFeed(db, userId, page, limit, headers, defaultPfp);
      }

      // Handle regular posts fetching with category filtering
      return await handleRegularPostsFetch(db, query, headers, defaultPfp);

    } catch (error) {
      console.error('Feed handler error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }
  }
};

// === PERSONALIZED FEED ALGORITHM ===
async function handlePersonalizedFeed(db, userId, page, limit, headers, defaultPfp) {
  try {
    console.log(`🎯 Generating personalized feed for user: ${userId}, page: ${page}`);
    
    // Get user data and relationships
    const userData = await getUserDataAndRelationships(db, userId);
    if (!userData) {
      return new Response(JSON.stringify({ message: 'User not found' }), {
        status: 404,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }

    // Get recently viewed posts (last 30 days for performance)
    const recentlyViewed = await getRecentlyViewedPosts(db, userId);
    
    // Generate feed composition
    const feedPosts = await generateFeedComposition(db, userData, recentlyViewed, limit);
    
    // Enrich posts with user data
    const enrichedPosts = await enrichPostsWithUserData(db, feedPosts, defaultPfp);
    
    console.log(`✅ Generated ${enrichedPosts.length} posts for user ${userId}`);
    
    return new Response(JSON.stringify({
      posts: enrichedPosts,
      hasMorePosts: true, // Always true for infinite scroll
      feedType: 'personalized',
      composition: getActualComposition(feedPosts)
    }), {
      status: 200,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Error in personalized feed:', error);
    return new Response(JSON.stringify({ error: 'Failed to generate personalized feed' }), {
      status: 500,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });
  }
}

// === USER DATA AND RELATIONSHIPS ===
async function getUserDataAndRelationships(db, userId) {
  try {
    // Get user basic info and location
    const userResult = await db.execute(
      'SELECT username, city, region, country FROM users WHERE username = ?',
      [userId]
    );

    if (userResult.rows.length === 0) return null;
    const user = userResult.rows[0];

    // Get friends (accepted relationships)
    const friendsResult = await db.execute(`
      SELECT CASE 
        WHEN follower = ? THEN following 
        ELSE follower 
      END as friend_username
      FROM follows 
      WHERE (follower = ? OR following = ?) 
      AND relationship_status = 'accepted'
    `, [userId, userId, userId]);

    // Get following (one-way follows)
    const followingResult = await db.execute(`
      SELECT following as following_username
      FROM follows 
      WHERE follower = ? AND relationship_status = 'none'
    `, [userId]);

    return {
      ...user,
      friends: friendsResult.rows.map(row => row.friend_username),
      following: followingResult.rows.map(row => row.following_username)
    };

  } catch (error) {
    console.error('Error getting user data:', error);
    throw error;
  }
}

// === RECENTLY VIEWED POSTS ===
async function getRecentlyViewedPosts(db, userId) {
  try {
    const viewedResult = await db.execute(`
      SELECT post_id 
      FROM post_views 
      WHERE user_id = ? 
      AND viewed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY viewed_at DESC
      LIMIT 1000
    `, [userId]);

    return new Set(viewedResult.rows.map(row => row.post_id));
  } catch (error) {
    console.error('Error getting viewed posts:', error);
    return new Set(); // Return empty set on error
  }
}

// === FEED COMPOSITION GENERATOR ===
async function generateFeedComposition(db, userData, recentlyViewed, limit) {
  const posts = [];
  
  // Target composition for 10 posts:
  const composition = {
    random: 4,    // Increased from 3
    following: 3, 
    friends: 2,   // Increased from 1
    regional: 1
  };

  try {
    // 1. Get Random/Discovery posts (4 posts)
    const randomPosts = await getRandomPosts(db, userData, recentlyViewed, composition.random);
    posts.push(...randomPosts);

    // 2. Get Following posts (3 posts)  
    const followingPosts = await getFollowingPosts(db, userData, recentlyViewed, composition.following);
    posts.push(...followingPosts);

    // 3. Get Friends posts (2 posts)
    const friendsPosts = await getFriendsPosts(db, userData, recentlyViewed, composition.friends);
    posts.push(...friendsPosts);

    // 4. Get Regional posts (1 post)
    const regionalPosts = await getRegionalPosts(db, userData, recentlyViewed, composition.regional);
    posts.push(...regionalPosts);

    // 5. Fill remaining slots with random if needed
    if (posts.length < limit) {
      const additionalRandom = await getRandomPosts(
        db,
        userData, 
        new Set([...recentlyViewed, ...posts.map(p => p._id)]), 
        limit - posts.length
      );
      posts.push(...additionalRandom);
    }

    // 6. Shuffle to avoid predictable patterns
    return shuffleArray(posts).slice(0, limit);

  } catch (error) {
    console.error('Error in feed composition:', error);
    // Fallback to random posts
    return await getRandomPosts(db, userData, recentlyViewed, limit);
  }
}

// === CONTENT FETCHING FUNCTIONS ===
async function getRandomPosts(db, userData, recentlyViewed, count) {
  if (count <= 0) return [];
  
  const viewedFilter = recentlyViewed.size > 0 
    ? `AND p._id NOT IN (${Array.from(recentlyViewed).map(() => '?').join(',')})` 
    : '';
  
  const result = await db.execute(`
    SELECT p.* FROM posts p
    WHERE p.timestamp > DATE_SUB(NOW(), INTERVAL 7 DAY)
    ${viewedFilter}
    ORDER BY RAND()
    LIMIT ?
  `, [...Array.from(recentlyViewed), count]);

  return result.rows.map(post => ({ ...post, feedType: 'random' }));
}

async function getFollowingPosts(db, userData, recentlyViewed, count) {
  if (count <= 0 || userData.following.length === 0) {
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }

  const viewedFilter = recentlyViewed.size > 0 
    ? `AND p._id NOT IN (${Array.from(recentlyViewed).map(() => '?').join(',')})` 
    : '';

  const followingPlaceholders = userData.following.map(() => '?').join(',');
  
  const result = await db.execute(`
    SELECT p.* FROM posts p
    WHERE p.username IN (${followingPlaceholders})
    ${viewedFilter}
    ORDER BY p.timestamp DESC
    LIMIT ?
  `, [...userData.following, ...Array.from(recentlyViewed), count]);

  return result.rows.map(post => ({ ...post, feedType: 'following' }));
}

async function getFriendsPosts(db, userData, recentlyViewed, count) {
  if (count <= 0 || userData.friends.length === 0) {
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }

  const viewedFilter = recentlyViewed.size > 0 
    ? `AND p._id NOT IN (${Array.from(recentlyViewed).map(() => '?').join(',')})` 
    : '';

  const friendsPlaceholders = userData.friends.map(() => '?').join(',');
  
  const result = await db.execute(`
    SELECT p.* FROM posts p
    WHERE p.username IN (${friendsPlaceholders})
    ${viewedFilter}
    ORDER BY (p.likes + p.hearts + CHAR_LENGTH(p.comments)) DESC, p.timestamp DESC
    LIMIT ?
  `, [...userData.friends, ...Array.from(recentlyViewed), count]);

  return result.rows.map(post => ({ ...post, feedType: 'friends' }));
}

async function getRegionalPosts(db, userData, recentlyViewed, count) {
  if (count <= 0) return [];

  const viewedFilter = recentlyViewed.size > 0 
    ? `AND p._id NOT IN (${Array.from(recentlyViewed).map(() => '?').join(',')})` 
    : '';

  // Try city first, then region, then country
  let posts = [];
  
  // City-level posts
  if (userData.city && posts.length < count) {
    const result = await db.execute(`
      SELECT p.* FROM posts p
      JOIN users u ON p.username = u.username
      WHERE u.city = ? AND p.username != ?
      ${viewedFilter}
      AND p.timestamp > DATE_SUB(NOW(), INTERVAL 3 DAY)
      ORDER BY (p.likes + p.hearts) DESC, p.timestamp DESC
      LIMIT ?
    `, [userData.city, userData.username, ...Array.from(recentlyViewed), count]);
    
    posts.push(...result.rows.map(post => ({ ...post, feedType: 'regional-city' })));
  }

  // Region-level posts if not enough city posts
  if (userData.region && posts.length < count) {
    const remaining = count - posts.length;
    const result = await db.execute(`
      SELECT p.* FROM posts p
      JOIN users u ON p.username = u.username
      WHERE u.region = ? AND p.username != ?
      ${viewedFilter}
      AND p._id NOT IN (${posts.length > 0 ? posts.map(() => '?').join(',') : "''"})
      AND p.timestamp > DATE_SUB(NOW(), INTERVAL 5 DAY)
      ORDER BY (p.likes + p.hearts) DESC, p.timestamp DESC
      LIMIT ?
    `, [userData.region, userData.username, ...Array.from(recentlyViewed), ...(posts.length > 0 ? posts.map(p => p._id) : []), remaining]);
    
    posts.push(...result.rows.map(post => ({ ...post, feedType: 'regional-region' })));
  }

  // Country-level posts if still not enough
  if (userData.country && posts.length < count) {
    const remaining = count - posts.length;
    const result = await db.execute(`
      SELECT p.* FROM posts p
      JOIN users u ON p.username = u.username
      WHERE u.country = ? AND p.username != ?
      ${viewedFilter}
      AND p._id NOT IN (${posts.length > 0 ? posts.map(() => '?').join(',') : "''"})
      AND p.timestamp > DATE_SUB(NOW(), INTERVAL 7 DAY)
      ORDER BY (p.likes + p.hearts) DESC, p.timestamp DESC
      LIMIT ?
    `, [userData.country, userData.username, ...Array.from(recentlyViewed), ...(posts.length > 0 ? posts.map(p => p._id) : []), remaining]);
    
    posts.push(...result.rows.map(post => ({ ...post, feedType: 'regional-country' })));
  }

  // Fill with random if still not enough
  if (posts.length < count) {
    const additionalRandom = await getRandomPosts(
      db,
      userData, 
      new Set([...recentlyViewed, ...posts.map(p => p._id)]), 
      count - posts.length
    );
    posts.push(...additionalRandom.map(post => ({ ...post, feedType: 'regional-fallback' })));
  }

  return posts.slice(0, count);
}

// === UTILITY FUNCTIONS ===
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getActualComposition(posts) {
  const composition = {};
  posts.forEach(post => {
    const type = post.feedType || 'unknown';
    composition[type] = (composition[type] || 0) + 1;
  });
  return composition;
}

// === EXISTING FUNCTIONS ===
async function handleUserProfile(db, username, headers) {
  const result = await db.execute(
    'SELECT username, profile_picture, Music, description, created_at FROM users WHERE username = ?',
    [username]
  );
  
  if (result.rows.length === 0) {
    return new Response(JSON.stringify({ message: 'User not found' }), {
      status: 404,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });
  }
  
  const user = result.rows[0];
  return new Response(JSON.stringify({
    username: user.username,
    profilePicture: user.profile_picture,
    Music: user.Music || 'Music not available',
    description: user.description || 'No description available',
    created_at: user.created_at || 'created_at not available'
  }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
  });
}

async function handleRegularPostsFetch(db, query, headers, defaultPfp) {
  const {
    username_like,
    start_timestamp,
    end_timestamp,
    page = 1,
    limit = 10,
    sort,
  } = query;

  let sql = 'SELECT * FROM posts';
  const params = [];
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const conditions = [];

  if (username_like) {
    conditions.push('username LIKE ?');
    params.push(`%${username_like}%`);
  }

  if (start_timestamp && end_timestamp) {
    conditions.push('timestamp BETWEEN ? AND ?');
    params.push(start_timestamp, end_timestamp);
  }

  if (sort && ['story_rant', 'sports', 'entertainment', 'news'].includes(sort)) {
    const categoryMap = {
      story_rant: 'Story/Rant',
      sports: 'Sports',
      entertainment: 'Entertainment',
      news: 'News',
    };
    conditions.push('categories = ?');
    params.push(categoryMap[sort]);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  const sortOptions = {
    trending: '(likes + comments_count + IFNULL(hearts, 0)) DESC, timestamp DESC',
    newest: 'timestamp DESC',
    general: 'timestamp DESC',
    story_rant: 'timestamp DESC',
    sports: 'timestamp DESC',
    entertainment: 'timestamp DESC',
    news: 'timestamp DESC',
  };

  sql += ` ORDER BY ${sortOptions[sort] || 'timestamp DESC'} LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), offset);

  const result = await db.execute(sql, params);
  const posts = result.rows;
  const enrichedPosts = await enrichPostsWithUserData(db, posts, defaultPfp);

  // Count total posts matching the filters
  let countQuery = 'SELECT COUNT(*) AS count FROM posts';
  if (conditions.length > 0) {
    countQuery += ' WHERE ' + conditions.join(' AND ');
  }
  const countParams = params.slice(0, params.length - 2);
  const countResult = await db.execute(countQuery, countParams);

  return new Response(JSON.stringify({
    posts: enrichedPosts,
    hasMorePosts: (page * limit) < countResult.rows[0].count,
    filterType: sort === 'general' ? 'general' : (sort || 'general'),
  }), {
    status: 200,
    headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
  });
}

async function enrichPostsWithUserData(db, posts, defaultPfp) {
  if (posts.length === 0) return [];

  // Get unique usernames from posts only
  const usernames = [...new Set(posts.map(p => p.username))];

  // Also get usernames from replyTo if any
  const replyToUsernames = posts
    .map(p => {
      try {
        const replyTo = p.replyTo ? JSON.parse(p.replyTo) : null;
        return replyTo?.username;
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // Combine usernames from posts and replyTo
  const allUsernames = [...new Set([...usernames, ...replyToUsernames])];

  const usersMap = {};
  if (allUsernames.length) {
    const userSql = `SELECT username, profile_picture FROM users WHERE username IN (${allUsernames.map(() => '?').join(',')})`;
    const result = await db.execute(userSql, allUsernames);
    const users = result.rows;

    users.forEach(u => {
      usersMap[u.username.toLowerCase()] = u.profile_picture?.startsWith('data:image')
        ? u.profile_picture
        : u.profile_picture
        ? `data:image/jpeg;base64,${u.profile_picture}`
        : defaultPfp;
    });
  }

  // Return lightweight post objects for feed view
  return posts.map(p => {
    // Enrich replyTo if present
    let replyToData = null;
    try {
      replyToData = p.replyTo ? JSON.parse(p.replyTo) : null;
      if (replyToData) {
        replyToData.profilePicture = usersMap[replyToData.username?.toLowerCase()] || defaultPfp;
      }
    } catch {
      replyToData = null;
    }

    return {
      _id: p._id,
      message: p.message,
      timestamp: p.timestamp,
      username: p.username,
      likes: p.likes,
      likedBy: (p.likedBy && typeof p.likedBy === 'string') ? JSON.parse(p.likedBy) : (p.likedBy || []),
      commentCount: p.comments_count || 0,
      photo: p.photo?.startsWith('http') || p.photo?.startsWith('data:image')
        ? p.photo
        : p.photo ? `data:image/jpeg;base64,${p.photo.toString('base64')}` : null,
      profilePicture: usersMap[p.username.toLowerCase()] || defaultPfp,
      tags: p.tags ? (typeof p.tags === 'string' ? JSON.parse(p.tags) : p.tags) || [] : [],
      feedType: p.feedType || 'regular',
      views_count: p.views_count || 0,
      replyTo: replyToData
    };
  });
}