// Cloudflare Workers handler for personalized feed
import { connect } from '@planetscale/database';

const setCorsHeaders = (request) => {
  const headers = new Headers();
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return headers;
};

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
      // Simple PlanetScale connection to your MySQL database
      const db = connect({
        url: `mysql://u208245805_Crypto21:Crypto21%40@srv787.hstgr.io:3306/u208245805_Crypto21`
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

      // Handle personalized feed
      if (userId && (sort === 'general' || !sort)) {
        return await handlePersonalizedFeed(db, userId, page, limit, headers, defaultPfp);
      }

      // Handle regular posts fetching
      return await handleRegularPostsFetch(db, query, headers, defaultPfp);

    } catch (error) {
      console.error('Feed handler error:', error);
      return new Response(JSON.stringify({ error: 'Internal server error', details: error.message }), {
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
    
    const userData = await getUserDataAndRelationships(db, userId);
    if (!userData) {
      return new Response(JSON.stringify({ message: 'User not found' }), {
        status: 404,
        headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
      });
    }

    const recentlyViewed = await getRecentlyViewedPosts(db, userId);
    const feedPosts = await generateFeedComposition(db, userData, recentlyViewed, limit);
    const enrichedPosts = await enrichPostsWithUserData(db, feedPosts, defaultPfp);
    
    console.log(`✅ Generated ${enrichedPosts.length} posts for user ${userId}`);
    
    return new Response(JSON.stringify({
      posts: enrichedPosts,
      hasMorePosts: true,
      feedType: 'personalized',
      composition: getActualComposition(feedPosts)
    }), {
      status: 200,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('❌ Error in personalized feed:', error);
    return new Response(JSON.stringify({ error: 'Failed to generate personalized feed', details: error.message }), {
      status: 500,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });
  }
}

// === USER DATA AND RELATIONSHIPS ===
async function getUserDataAndRelationships(db, userId) {
  try {
    const userResult = await db.execute(
      'SELECT username, city, region, country FROM users WHERE username = ?',
      [userId]
    );

    if (userResult.rows.length === 0) return null;
    const user = userResult.rows[0];

    const friendsResult = await db.execute(`
      SELECT CASE 
        WHEN follower = ? THEN following 
        ELSE follower 
      END as friend_username
      FROM follows 
      WHERE (follower = ? OR following = ?) 
      AND relationship_status = 'accepted'
    `, [userId, userId, userId]);

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
    const result = await db.execute(`
      SELECT post_id 
      FROM post_views 
      WHERE user_id = ? 
      AND viewed_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
      ORDER BY viewed_at DESC
      LIMIT 1000
    `, [userId]);

    return new Set(result.rows.map(row => row.post_id));
  } catch (error) {
    console.error('Error getting viewed posts:', error);
    return new Set();
  }
}

// === FEED COMPOSITION GENERATOR ===
async function generateFeedComposition(db, userData, recentlyViewed, limit) {
  const posts = [];
  
  const composition = {
    random: 4,
    following: 3, 
    friends: 2,
    regional: 1
  };

  try {
    const randomPosts = await getRandomPosts(db, userData, recentlyViewed, composition.random);
    posts.push(...randomPosts);

    const followingPosts = await getFollowingPosts(db, userData, recentlyViewed, composition.following);
    posts.push(...followingPosts);

    const friendsPosts = await getFriendsPosts(db, userData, recentlyViewed, composition.friends);
    posts.push(...friendsPosts);

    const regionalPosts = await getRegionalPosts(db, userData, recentlyViewed, composition.regional);
    posts.push(...regionalPosts);

    if (posts.length < limit) {
      const additionalRandom = await getRandomPosts(
        db,
        userData, 
        new Set([...recentlyViewed, ...posts.map(p => p._id)]), 
        limit - posts.length
      );
      posts.push(...additionalRandom);
    }

    return shuffleArray(posts).slice(0, limit);

  } catch (error) {
    console.error('Error in feed composition:', error);
    return await getRandomPosts(db, userData, recentlyViewed, limit);
  }
}

// === CONTENT FETCHING FUNCTIONS ===
async function getRandomPosts(db, userData, recentlyViewed, count) {
  if (count <= 0) return [];
  
  try {
    const viewedArray = Array.from(recentlyViewed);
    let sql = 'SELECT p.* FROM posts p WHERE p.timestamp > DATE_SUB(NOW(), INTERVAL 7 DAY)';
    const params = [];
    
    if (viewedArray.length > 0) {
      const placeholders = viewedArray.map(() => '?').join(',');
      sql += ` AND p._id NOT IN (${placeholders})`;
      params.push(...viewedArray);
    }
    
    sql += ' ORDER BY RAND() LIMIT ?';
    params.push(count);

    const result = await db.execute(sql, params);
    return result.rows.map(post => ({ ...post, feedType: 'random' }));
  } catch (error) {
    console.error('Error getting random posts:', error);
    return [];
  }
}

async function getFollowingPosts(db, userData, recentlyViewed, count) {
  if (count <= 0 || userData.following.length === 0) {
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }

  try {
    const viewedArray = Array.from(recentlyViewed);
    const followingPlaceholders = userData.following.map(() => '?').join(',');
    
    let sql = `SELECT p.* FROM posts p WHERE p.username IN (${followingPlaceholders})`;
    const params = [...userData.following];
    
    if (viewedArray.length > 0) {
      const viewedPlaceholders = viewedArray.map(() => '?').join(',');
      sql += ` AND p._id NOT IN (${viewedPlaceholders})`;
      params.push(...viewedArray);
    }
    
    sql += ' ORDER BY p.timestamp DESC LIMIT ?';
    params.push(count);
    
    const result = await db.execute(sql, params);
    return result.rows.map(post => ({ ...post, feedType: 'following' }));
  } catch (error) {
    console.error('Error getting following posts:', error);
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }
}

async function getFriendsPosts(db, userData, recentlyViewed, count) {
  if (count <= 0 || userData.friends.length === 0) {
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }

  try {
    const viewedArray = Array.from(recentlyViewed);
    const friendsPlaceholders = userData.friends.map(() => '?').join(',');
    
    let sql = `SELECT p.* FROM posts p WHERE p.username IN (${friendsPlaceholders})`;
    const params = [...userData.friends];
    
    if (viewedArray.length > 0) {
      const viewedPlaceholders = viewedArray.map(() => '?').join(',');
      sql += ` AND p._id NOT IN (${viewedPlaceholders})`;
      params.push(...viewedArray);
    }
    
    sql += ' ORDER BY (p.likes + p.hearts + CHAR_LENGTH(p.comments)) DESC, p.timestamp DESC LIMIT ?';
    params.push(count);
    
    const result = await db.execute(sql, params);
    return result.rows.map(post => ({ ...post, feedType: 'friends' }));
  } catch (error) {
    console.error('Error getting friends posts:', error);
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }
}

async function getRegionalPosts(db, userData, recentlyViewed, count) {
  if (count <= 0) return [];

  try {
    const viewedArray = Array.from(recentlyViewed);
    let posts = [];
    
    // Try city, region, then country
    if (userData.city && posts.length < count) {
      let sql = `
        SELECT p.* FROM posts p
        JOIN users u ON p.username = u.username
        WHERE u.city = ? AND p.username != ?
        AND p.timestamp > DATE_SUB(NOW(), INTERVAL 3 DAY)
      `;
      
      const params = [userData.city, userData.username];
      
      if (viewedArray.length > 0) {
        const placeholders = viewedArray.map(() => '?').join(',');
        sql += ` AND p._id NOT IN (${placeholders})`;
        params.push(...viewedArray);
      }
      
      sql += ' ORDER BY (p.likes + p.hearts) DESC, p.timestamp DESC LIMIT ?';
      params.push(count);
      
      const result = await db.execute(sql, params);
      posts.push(...result.rows.map(post => ({ ...post, feedType: 'regional-city' })));
    }

    return posts.slice(0, count);
  } catch (error) {
    console.error('Error getting regional posts:', error);
    return await getRandomPosts(db, userData, recentlyViewed, count);
  }
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
  try {
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
  } catch (error) {
    console.error('Error in user profile:', error);
    return new Response(JSON.stringify({ error: 'Failed to get user profile', details: error.message }), {
      status: 500,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });
  }
}

async function handleRegularPostsFetch(db, query, headers, defaultPfp) {
  try {
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
  } catch (error) {
    console.error('Error in regular posts fetch:', error);
    return new Response(JSON.stringify({ error: 'Failed to fetch posts', details: error.message }), {
      status: 500,
      headers: { ...Object.fromEntries(headers), 'Content-Type': 'application/json' }
    });
  }
}

async function enrichPostsWithUserData(db, posts, defaultPfp) {
  if (posts.length === 0) return [];

  try {
    const usernames = [...new Set(posts.map(p => p.username))];
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

    return posts.map(p => {
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
  } catch (error) {
    console.error('Error enriching posts:', error);
    return posts.map(p => ({
      _id: p._id,
      message: p.message,
      timestamp: p.timestamp,
      username: p.username,
      likes: p.likes,
      likedBy: [],
      commentCount: p.comments_count || 0,
      photo: null,
      profilePicture: defaultPfp,
      tags: [],
      feedType: p.feedType || 'regular',
      views_count: p.views_count || 0,
      replyTo: null
    }));
  }
}

