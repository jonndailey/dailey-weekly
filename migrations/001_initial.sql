CREATE TABLE IF NOT EXISTS categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS posts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  content TEXT NOT NULL,
  excerpt VARCHAR(500),
  category_id INT,
  tags JSON,
  published BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

INSERT INTO categories (name, slug) VALUES ('Technology', 'technology');
INSERT INTO categories (name, slug) VALUES ('Design', 'design');
INSERT INTO categories (name, slug) VALUES ('Business', 'business');

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Getting Started with Modern Web Development',
  'getting-started-modern-web-development',
  '## Introduction\n\nWelcome to the world of modern web development. In this post, we will explore the key concepts and tools that every developer should know.\n\n## The Basics\n\nModern web development revolves around three core technologies:\n\n- **HTML** for structure\n- **CSS** for styling\n- **JavaScript** for interactivity\n\n## Frameworks and Tools\n\nThe ecosystem has grown tremendously. From React and Vue on the frontend to Node.js and Express on the backend, developers have more choices than ever.\n\n### Node.js\n\nNode.js revolutionized server-side development by bringing JavaScript to the backend. Its event-driven, non-blocking I/O model makes it perfect for building scalable applications.\n\n### Express\n\nExpress is a minimal and flexible Node.js web application framework that provides a robust set of features for web and mobile applications.\n\n## Conclusion\n\nThe best way to learn is by building. Start with a simple project and gradually add complexity as you grow more comfortable with the tools.',
  'Explore the key concepts and tools that every modern web developer should know, from HTML and CSS to Node.js and Express.',
  1,
  '["webdev", "javascript", "nodejs"]',
  TRUE,
  NOW()
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Principles of Clean UI Design',
  'principles-clean-ui-design',
  '## Why Design Matters\n\nGood design is not just about aesthetics — it is about communication. A well-designed interface guides users naturally through your application.\n\n## Core Principles\n\n### 1. Hierarchy\n\nVisual hierarchy helps users understand what is most important on a page. Use size, color, and spacing to create clear distinctions between elements.\n\n### 2. Consistency\n\nConsistent design patterns reduce cognitive load. When buttons, forms, and navigation behave predictably, users can focus on their tasks rather than learning the interface.\n\n### 3. Whitespace\n\nDo not fear empty space. Whitespace gives your content room to breathe and dramatically improves readability.\n\n### 4. Typography\n\nChoose fonts carefully. A good type system uses no more than 2-3 font families and establishes clear size relationships.\n\n## Practical Tips\n\n- Start with mobile layouts first\n- Use a consistent color palette (5-7 colors max)\n- Test with real users early and often\n- Accessibility is not optional\n\n## Final Thoughts\n\nGreat design is invisible. When users can accomplish their goals without thinking about the interface, you have done your job well.',
  'Learn the core principles of clean UI design including hierarchy, consistency, whitespace, and typography.',
  2,
  '["design", "ui", "ux"]',
  TRUE,
  NOW()
);

INSERT INTO posts (title, slug, content, excerpt, category_id, tags, published, published_at) VALUES (
  'Building a Successful SaaS Product',
  'building-successful-saas-product',
  '## The SaaS Opportunity\n\nSoftware as a Service continues to be one of the most attractive business models in technology. Recurring revenue, scalability, and global reach make it compelling for entrepreneurs.\n\n## Finding Your Niche\n\nThe most successful SaaS products solve a specific problem extremely well. Rather than building a platform that does everything, focus on one pain point and nail it.\n\n### Validation Steps\n\n1. Talk to potential customers before writing code\n2. Build a landing page and measure interest\n3. Create a minimal prototype and get feedback\n4. Only then invest in full development\n\n## Key Metrics\n\nEvery SaaS founder should track:\n\n- **MRR** (Monthly Recurring Revenue)\n- **Churn Rate** — the percentage of customers who cancel\n- **CAC** (Customer Acquisition Cost)\n- **LTV** (Lifetime Value)\n\n## Growth Strategies\n\n### Content Marketing\n\nCreate valuable content that attracts your target audience. Blog posts, tutorials, and case studies establish authority and drive organic traffic.\n\n### Product-Led Growth\n\nLet the product sell itself. Offer a generous free tier, make onboarding seamless, and build features that naturally encourage sharing.\n\n## Conclusion\n\nBuilding a SaaS product is a marathon, not a sprint. Focus on delivering real value, listen to your customers, and iterate relentlessly.',
  'Learn the fundamentals of building a successful SaaS product, from finding your niche to tracking key metrics.',
  3,
  '["saas", "business", "startup"]',
  TRUE,
  NOW()
)
