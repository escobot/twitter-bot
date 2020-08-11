


class QElement {
    constructor(element, priority) {
        this.element = element;
        this.priority = priority;
    }
}


class PriorityQueue {
    constructor() {
        this.items = [];
    }

    // add element to priority queue (ascending order of priority)
    enqueue(element, priority) {
        let qElement = new QElement(element, priority);
        let contain = false;

        // add element in ascending order
        for (let i = 0; i < this.items.length; i++) {
            if (this.items[i].priority > qElement.priority) {
                this.items.splice(i, 0, qElement);
                contain = true;
                break;
            }
        }

        // add at end if priority of element if greatest
        if (!contain) {
            this.items.push(qElement);
        }
    }

    // removes last element from priority queue (highest priority number)
    dequeue() {
        if (this.isEmpty())
            return null;
        // remove first element of array
        return this.items.pop();
    }

    // returns front element from queue
    front() {
        if (this.isEmpty())
            return null
        return this.items[0];
    }


    // returns rear element from queue
    rear() {
        if (this.isEmpty())
            return null;
        return this.items[this.items.length - 1];
    }

    isEmpty() {
        return this.items.length == 0;
    }
}